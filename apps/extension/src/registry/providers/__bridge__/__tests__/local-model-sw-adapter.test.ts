import { describe, expect, it, vi } from "vitest";
import type { LocalModelCallOptions } from "../local-model-messages";
import { createLocalModelSwAdapter } from "../local-model-sw-adapter";

/**
 * The SW-side adapter is a `LanguageModelV3` proxy over a `chrome.runtime`
 * Port. These tests drive it against a fake Port (no browser) and assert:
 *
 *  - `doStream` opens a port, sends a serializable `LM_START` (no
 *    `abortSignal`), and surfaces `LM_CHUNK`/`LM_DONE`/`LM_ERROR`.
 *  - Aborting the call posts `LM_CANCEL` and errors the stream.
 *  - `doGenerate` resolves on `LM_GENERATE_RESULT` and rejects on `LM_ERROR`.
 *  - A port disconnect before completion errors the consumer.
 */

interface FakePort {
  port: chrome.runtime.Port;
  posted: unknown[];
  emit: (msg: unknown) => void;
  emitDisconnect: () => void;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeFakePort(): FakePort {
  const messageListeners: ((m: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const posted: unknown[] = [];
  const disconnect = vi.fn();

  const port = {
    name: "",
    postMessage: (m: unknown) => posted.push(m),
    disconnect,
    onMessage: {
      addListener: (fn: (m: unknown) => void) => messageListeners.push(fn),
      removeListener: (fn: (m: unknown) => void) => {
        const i = messageListeners.indexOf(fn);
        if (i >= 0) messageListeners.splice(i, 1);
      },
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.push(fn),
      removeListener: (fn: () => void) => {
        const i = disconnectListeners.indexOf(fn);
        if (i >= 0) disconnectListeners.splice(i, 1);
      },
    },
  } as unknown as chrome.runtime.Port;

  return {
    port,
    posted,
    emit: (msg) => messageListeners.slice().forEach((fn) => fn(msg)),
    emitDisconnect: () => disconnectListeners.slice().forEach((fn) => fn()),
    disconnect,
  };
}

function makeOptions(
  extra: Partial<LocalModelCallOptions> = {},
): LocalModelCallOptions {
  return { prompt: [], ...extra } as unknown as LocalModelCallOptions;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeAdapter(
  fake: FakePort,
  connectInfoSink?: (i: { name: string }) => void,
) {
  return createLocalModelSwAdapter(
    "web-llm",
    { some: "config" },
    "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    {
      connect: (info) => {
        connectInfoSink?.(info);
        return fake.port;
      },
      ensureOffscreen: async () => {},
      randomId: () => "test-uuid",
    },
  );
}

describe("createLocalModelSwAdapter", () => {
  it("exposes a v3 model with provider/model identity and no supported URLs", () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("web-llm");
    expect(model.modelId).toBe("Llama-3.2-3B-Instruct-q4f16_1-MLC");
    expect(model.supportedUrls).toEqual({});
  });

  it("doStream sends a serializable LM_START and streams chunks then closes", async () => {
    const fake = makeFakePort();
    let connectedName = "";
    const model = makeAdapter(fake, (i) => {
      connectedName = i.name;
    });

    const abortSignal = new AbortController().signal;
    const { stream } = await model.doStream(makeOptions({ abortSignal }));

    expect(connectedName).toBe("offscreen-lm:test-uuid");
    // First (and only) outbound message is LM_START without abortSignal.
    expect(fake.posted).toHaveLength(1);
    const start = fake.posted[0] as Record<string, unknown>;
    expect(start.type).toBe("LM_START");
    expect(start.mode).toBe("stream");
    expect(start.providerId).toBe("web-llm");
    expect(start.modelId).toBe("Llama-3.2-3B-Instruct-q4f16_1-MLC");
    expect(
      (start.options as Record<string, unknown>).abortSignal,
    ).toBeUndefined();
    expect((start.options as Record<string, unknown>).prompt).toEqual([]);

    const reader = stream.getReader();

    fake.emit({
      type: "LM_CHUNK",
      part: { type: "text-delta", id: "1", delta: "he" },
    });
    const r1 = await reader.read();
    expect(r1.done).toBe(false);
    expect(r1.value).toEqual({ type: "text-delta", id: "1", delta: "he" });

    fake.emit({ type: "LM_DONE" });
    const r2 = await reader.read();
    expect(r2.done).toBe(true);
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it("doStream revives a response-metadata timestamp string into a Date", async () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    const { stream } = await model.doStream(makeOptions());
    const reader = stream.getReader();

    const iso = "2026-06-25T00:00:00.000Z";
    fake.emit({
      type: "LM_CHUNK",
      part: { type: "response-metadata", timestamp: iso },
    });
    const r = await reader.read();
    const part = r.value as { type: string; timestamp: unknown };
    expect(part.timestamp).toBeInstanceOf(Date);
    expect((part.timestamp as Date).toISOString()).toBe(iso);
  });

  it("doStream surfaces LM_ERROR as a stream error", async () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    const { stream } = await model.doStream(makeOptions());
    const reader = stream.getReader();

    fake.emit({ type: "LM_ERROR", message: "WebGPU unavailable" });
    await expect(reader.read()).rejects.toThrow("WebGPU unavailable");
  });

  it("doStream errors when the port disconnects before completion", async () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    const { stream } = await model.doStream(makeOptions());
    const reader = stream.getReader();

    fake.emitDisconnect();
    await expect(reader.read()).rejects.toThrow(/disconnected/);
  });

  it("aborting the signal posts LM_CANCEL and errors the stream", async () => {
    const fake = makeFakePort();
    const controller = new AbortController();
    const model = makeAdapter(fake);
    const { stream } = await model.doStream(
      makeOptions({ abortSignal: controller.signal }),
    );
    const reader = stream.getReader();

    controller.abort();

    const cancel = fake.posted.find(
      (m) => (m as Record<string, unknown>).type === "LM_CANCEL",
    );
    expect(cancel).toBeDefined();
    await expect(reader.read()).rejects.toThrow();
  });

  it("stream.cancel() posts LM_CANCEL and disconnects", async () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    const { stream } = await model.doStream(makeOptions());
    await stream.cancel();
    const cancel = fake.posted.find(
      (m) => (m as Record<string, unknown>).type === "LM_CANCEL",
    );
    expect(cancel).toBeDefined();
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it("doGenerate resolves on LM_GENERATE_RESULT", async () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    const promise = model.doGenerate(makeOptions());
    // `doGenerate` awaits `ensureOffscreen` (a microtask) before posting.
    await flush();

    const start = fake.posted[0] as Record<string, unknown>;
    expect(start.type).toBe("LM_START");
    expect(start.mode).toBe("generate");

    const result = {
      content: [{ type: "text", text: "hi" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    };
    fake.emit({ type: "LM_GENERATE_RESULT", result });
    await expect(promise).resolves.toMatchObject({ finishReason: "stop" });
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it("doGenerate rejects on LM_ERROR", async () => {
    const fake = makeFakePort();
    const model = makeAdapter(fake);
    const promise = model.doGenerate(makeOptions());
    await flush();
    fake.emit({ type: "LM_ERROR", message: "boom" });
    await expect(promise).rejects.toThrow("boom");
  });
});
