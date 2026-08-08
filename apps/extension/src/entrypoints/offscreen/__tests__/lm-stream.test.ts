import type {
  LocalModelProviderId,
  LocalModelStreamPart,
  LocalModelV3,
} from "@/registry/providers/__bridge__/local-model-messages";
import { describe, expect, it, vi } from "vitest";
import { attachLocalModelPort } from "../lm-stream";

/**
 * The offscreen handler owns one `offscreen-lm:*` Port: it builds/reuses the
 * real local model and drives `doStream`/`doGenerate`, streaming parts back.
 * These tests inject a fake model + fake Port and assert:
 *
 *  - stream mode posts one `LM_CHUNK` per part, then `LM_DONE`;
 *  - `LM_CANCEL` aborts the signal handed to the model, and the worker stops
 *    emitting tokens (the mid-stream abort requirement);
 *  - generate mode posts a single `LM_GENERATE_RESULT`;
 *  - `error` stream parts carrying an `Error` are coerced to a string;
 *  - model construction failure posts `LM_ERROR`.
 */

interface FakePort {
  port: chrome.runtime.Port;
  posted: unknown[];
  emit: (msg: unknown) => void;
  emitDisconnect: () => void;
}

function makeFakePort(): FakePort {
  const messageListeners: ((m: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const posted: unknown[] = [];

  const port = {
    name: "offscreen-lm:abc",
    postMessage: (m: unknown) => posted.push(m),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn: (m: unknown) => void) => messageListeners.push(fn),
      removeListener: () => {},
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.push(fn),
      removeListener: () => {},
    },
  } as unknown as chrome.runtime.Port;

  return {
    port,
    posted,
    emit: (msg) => messageListeners.slice().forEach((fn) => fn(msg)),
    emitDisconnect: () => disconnectListeners.slice().forEach((fn) => fn()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function startMsg(mode: "stream" | "generate") {
  return {
    type: "LM_START",
    mode,
    providerId: "web-llm" as LocalModelProviderId,
    config: {},
    modelId: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    options: { prompt: [] },
  };
}

/** Minimal fake `LanguageModelV3` whose behavior the test controls. */
function fakeModel(impl: Partial<LocalModelV3>): LocalModelV3 {
  return {
    specificationVersion: "v3",
    provider: "web-llm",
    modelId: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    supportedUrls: {},
    doStream: async () => ({ stream: new ReadableStream() }),
    doGenerate: async () => ({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    }),
    ...impl,
  } as LocalModelV3;
}

describe("attachLocalModelPort", () => {
  it("streams one LM_CHUNK per part then LM_DONE", async () => {
    const fake = makeFakePort();
    const parts: LocalModelStreamPart[] = [
      { type: "text-delta", id: "1", delta: "he" },
      { type: "text-delta", id: "1", delta: "llo" },
    ];
    const model = fakeModel({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      }),
    });

    attachLocalModelPort(fake.port, { getModel: async () => model });
    fake.emit(startMsg("stream"));
    await flush();

    expect(fake.posted).toEqual([
      { type: "LM_CHUNK", part: parts[0] },
      { type: "LM_CHUNK", part: parts[1] },
      { type: "LM_DONE" },
    ]);
  });

  it("LM_CANCEL aborts the model signal and stops emitting tokens", async () => {
    const fake = makeFakePort();
    let capturedSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController | null = null;

    const model = fakeModel({
      doStream: async (options: { abortSignal?: AbortSignal }) => {
        capturedSignal = options.abortSignal;
        const stream = new ReadableStream({
          start(c) {
            streamController = c;
            c.enqueue({
              type: "text-delta",
              id: "1",
              delta: "first",
            } satisfies LocalModelStreamPart);
          },
        });
        // A well-behaved local model stops when aborted.
        options.abortSignal?.addEventListener("abort", () => {
          try {
            streamController?.close();
          } catch {
            /* already closed */
          }
        });
        return { stream };
      },
    });

    attachLocalModelPort(fake.port, { getModel: async () => model });
    fake.emit(startMsg("stream"));
    await flush();

    // First token delivered; stream is still open awaiting more.
    expect(fake.posted).toEqual([
      {
        type: "LM_CHUNK",
        part: { type: "text-delta", id: "1", delta: "first" },
      },
    ]);

    fake.emit({ type: "LM_CANCEL" });
    await flush();

    expect(capturedSignal?.aborted).toBe(true);
    // No further chunks after the cancel — only the terminal LM_DONE.
    expect(fake.posted).toEqual([
      {
        type: "LM_CHUNK",
        part: { type: "text-delta", id: "1", delta: "first" },
      },
      { type: "LM_DONE" },
    ]);
  });

  it("generate mode posts a single LM_GENERATE_RESULT", async () => {
    const fake = makeFakePort();
    const result = {
      content: [{ type: "text", text: "done" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    };
    const model = fakeModel({ doGenerate: async () => result as never });

    attachLocalModelPort(fake.port, { getModel: async () => model });
    fake.emit(startMsg("generate"));
    await flush();

    expect(fake.posted).toEqual([{ type: "LM_GENERATE_RESULT", result }]);
  });

  it("coerces an Error in an error stream part to a string", async () => {
    const fake = makeFakePort();
    const model = fakeModel({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({
              type: "error",
              error: new Error("kaboom"),
            } satisfies LocalModelStreamPart);
            c.close();
          },
        }),
      }),
    });

    attachLocalModelPort(fake.port, { getModel: async () => model });
    fake.emit(startMsg("stream"));
    await flush();

    expect(fake.posted).toEqual([
      { type: "LM_CHUNK", part: { type: "error", error: "kaboom" } },
      { type: "LM_DONE" },
    ]);
  });

  it("posts LM_ERROR when model construction fails", async () => {
    const fake = makeFakePort();
    attachLocalModelPort(fake.port, {
      getModel: async () => {
        throw new Error("no WebGPU");
      },
    });
    fake.emit(startMsg("stream"));
    await flush();

    expect(fake.posted).toEqual([{ type: "LM_ERROR", message: "no WebGPU" }]);
  });
});

/**
 * Passive coherence check: a finished WebLLM reply that scores as corrupted
 * broadcasts LOCAL_MODEL_OUTPUT_GARBLED so the UI can explain the known
 * quantization/WebGPU failure instead of leaving the user with mystery
 * nonsense. Deliberately scoped to `web-llm` — cloud providers don't have this
 * failure mode and scoring them would be pure overhead.
 */
describe("attachLocalModelPort — passive coherence check", () => {
  /** Real captured corruption from Hermes-3-Llama-3.1-8B q4f16 on Metal. */
  const GARBLED =
    "Coltsresetellaovsky fav-describedby-wh\u00e1958puaugeihan (_REFiggerslinger " +
    "b\u00e1s\u0926\u0930 Cochphpadinndaie\u017c\u043e\u043c\u0435\u043d\u0127 " +
    "Creative\u0430\u043b\u0435abwe-May326\u044b\u0432ibold \u4ecb unreal387 " +
    "Cunningham460 McCarthy\u0447sitherurs\uFFFDaste ifad\uFFFD\uFFFD " +
    "\u0634\u0645\u0627\u0644\u0649CU \u30f3\u30d4";

  function streamOf(text: string) {
    return fakeModel({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-delta", id: "1", delta: text });
            c.close();
          },
        }),
      }),
    });
  }

  function garbledBroadcasts(spy: {
    mock: { calls: unknown[][] };
  }): { type?: string; modelId?: string }[] {
    return spy.mock.calls
      .map((c) => c[0] as { type?: string; modelId?: string })
      .filter((m) => m?.type === "LOCAL_MODEL_OUTPUT_GARBLED");
  }

  it("broadcasts when a WebLLM reply is corrupted", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage");
    const fake = makeFakePort();
    attachLocalModelPort(fake.port, { getModel: async () => streamOf(GARBLED) });
    fake.emit(startMsg("stream"));
    await flush();

    const sent = garbledBroadcasts(spy);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      modelId: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    });
    // Still streams the tokens through — the check never swallows output.
    expect(fake.posted.at(-1)).toEqual({ type: "LM_DONE" });
    spy.mockRestore();
  });

  it("stays silent on a healthy WebLLM reply", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage");
    const fake = makeFakePort();
    attachLocalModelPort(fake.port, {
      getModel: async () => streamOf("Hello! How can I help you today?"),
    });
    fake.emit(startMsg("stream"));
    await flush();

    expect(garbledBroadcasts(spy)).toHaveLength(0);
    spy.mockRestore();
  });

  it("does not score non-WebLLM providers", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage");
    const fake = makeFakePort();
    attachLocalModelPort(fake.port, { getModel: async () => streamOf(GARBLED) });
    fake.emit({
      ...startMsg("stream"),
      providerId: "browser-ai" as LocalModelProviderId,
    });
    await flush();

    expect(garbledBroadcasts(spy)).toHaveLength(0);
    spy.mockRestore();
  });
});
