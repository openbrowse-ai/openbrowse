/**
 * OpenCode Go routes by a client-supplied session id: a request without
 * `x-opencode-session` is answered HTTP 400 `MissingSessionID`. These tests
 * pin the contract end to end at the provider layer — which header goes out,
 * on which wire protocol, with which id, and that nothing else is affected.
 *
 * Everything runs against a mocked `fetch`; no network, no real API key.
 * (Mocked verification only — see the PR notes for what was checked live.)
 */

import { generateText, stepCountIs, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  conversationRequestContext,
  oneShotRequestContext,
} from "@/registry/providers/request-context";
import type { ProviderDefinition } from "@/registry/providers/types";
import { fromModelsDevProvider } from "../from-models-dev";
import type { ModelsDevModel, ModelsDevProvider } from "../types";

const SESSION_HEADER = "x-opencode-session";
const FAKE_KEY = "test-key-not-a-real-credential";
const GO_BASE = "https://opencode.ai/inference/go/v1";

function model(id: string, provider?: ModelsDevModel["provider"]): ModelsDevModel {
  return {
    id,
    name: id,
    tool_call: true,
    limit: { context: 128_000, output: 8_192 },
    modalities: { input: ["text"], output: ["text"] },
    ...(provider ? { provider } : {}),
  };
}

/** Same shape as models.dev's `opencode-go` entry: one default protocol plus per-model overrides. */
const OPENCODE_GO: ModelsDevProvider = {
  id: "opencode-go",
  name: "OpenCode Go",
  npm: "@ai-sdk/openai-compatible",
  api: GO_BASE,
  env: ["OPENCODE_API_KEY"],
  models: {
    "deepseek-v4.1-flash": model("deepseek-v4.1-flash"),
    "qwen3.8-flash": model("qwen3.8-flash", { npm: "@ai-sdk/anthropic" }),
    "gpt-6-luna": model("gpt-6-luna", { npm: "@ai-sdk/openai" }),
  },
};

/** Same SDK and shape as OpenCode Go, different provider: must never get the header. */
const OTHER_COMPATIBLE: ModelsDevProvider = {
  id: "some-other-gateway",
  name: "Some Other Gateway",
  npm: "@ai-sdk/openai-compatible",
  api: "https://api.example.com/v1",
  env: ["OTHER_API_KEY"],
  models: { "deepseek-v4.1-flash": model("deepseek-v4.1-flash") },
};

/** OpenCode Zen is OpenCode's other product; its docs do not ask for the header. */
const OPENCODE_ZEN: ModelsDevProvider = {
  id: "opencode",
  name: "OpenCode Zen",
  npm: "@ai-sdk/openai-compatible",
  api: "https://opencode.ai/inference/v1",
  env: ["OPENCODE_API_KEY"],
  models: { "deepseek-v4-pro": model("deepseek-v4-pro") },
};

interface Recorded {
  url: string;
  headers: Headers;
}

const CHAT_COMPLETION = {
  id: "cmpl-1",
  created: 1,
  model: "m",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const TOOL_CALL_COMPLETION = {
  ...CHAT_COMPLETION,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "echo", arguments: '{"text":"hi"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

let recorded: Recorded[];
let responder: (n: number) => Response;

beforeEach(() => {
  recorded = [];
  responder = () => Response.json(CHAT_COMPLETION);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      recorded.push({
        url: String(input),
        headers: new Headers(init?.headers as HeadersInit),
      });
      return responder(recorded.length);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Builds a model through the real registry mapping, then fires one request. */
async function send(
  def: ProviderDefinition,
  modelId: string,
  sessionId?: string,
  opts: { maxRetries?: number } = {},
): Promise<void> {
  const lm = await def.createLanguageModel(
    { apiKey: FAKE_KEY },
    modelId,
    sessionId === undefined ? undefined : { sessionId },
  );
  await generateText({
    model: lm,
    prompt: "hi",
    maxRetries: opts.maxRetries ?? 0,
  }).catch(() => {
    // Non-chat protocols get a chat-shaped body from the mock and fail to
    // parse it; only the outgoing request matters here.
  });
}

const goProvider = () => fromModelsDevProvider(OPENCODE_GO, undefined);

describe("OpenCode Go session header", () => {
  it("sends the header on chat/completions (default protocol, DeepSeek V4.1 Flash)", async () => {
    await send(goProvider(), "deepseek-v4.1-flash", "conv-1");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe(`${GO_BASE}/chat/completions`);
    expect(recorded[0].headers.get(SESSION_HEADER)).toBe("conv-1");
  });

  it("sends the header on every wire protocol Go serves, each on its own route", async () => {
    const routes: Record<string, string> = {
      "deepseek-v4.1-flash": `${GO_BASE}/chat/completions`,
      "qwen3.8-flash": `${GO_BASE}/messages`,
      "gpt-6-luna": `${GO_BASE}/responses`,
    };
    for (const [modelId, url] of Object.entries(routes)) {
      recorded.length = 0;
      await send(goProvider(), modelId, "conv-1");
      expect(recorded, modelId).toHaveLength(1);
      expect(recorded[0].url, modelId).toBe(url);
      expect(recorded[0].headers.get(SESSION_HEADER), modelId).toBe("conv-1");
    }
  });

  it("does not send Qwen to chat/completions (Anthropic-compatible /messages only)", async () => {
    await send(goProvider(), "qwen3.8-flash", "conv-1");

    expect(recorded.map((r) => r.url)).toEqual([`${GO_BASE}/messages`]);
    expect(recorded.some((r) => r.url.endsWith("/chat/completions"))).toBe(false);
  });

  it("keeps API-key authentication working on each protocol", async () => {
    await send(goProvider(), "deepseek-v4.1-flash", "conv-1");
    expect(recorded[0].headers.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);

    recorded.length = 0;
    await send(goProvider(), "qwen3.8-flash", "conv-1");
    expect(recorded[0].headers.get("x-api-key")).toBe(FAKE_KEY);
    // The Anthropic adapter's own browser-access header must survive the merge.
    expect(
      recorded[0].headers.get("anthropic-dangerous-direct-browser-access"),
    ).toBe("true");
  });

  it("never claims to be the OpenCode CLI", async () => {
    await send(goProvider(), "deepseek-v4.1-flash", "conv-1");
    const ua = recorded[0].headers.get("user-agent") ?? "";
    expect(ua.toLowerCase()).not.toContain("opencode");
  });

  it("sends no header at all when no session id was supplied (never invents one)", async () => {
    await send(goProvider(), "deepseek-v4.1-flash");
    expect(recorded[0].headers.has(SESSION_HEADER)).toBe(false);

    recorded.length = 0;
    const lm = await goProvider().createLanguageModel(
      { apiKey: FAKE_KEY },
      "deepseek-v4.1-flash",
      conversationRequestContext(null),
    );
    await generateText({ model: lm, prompt: "hi", maxRetries: 0 });
    expect(recorded[0].headers.has(SESSION_HEADER)).toBe(false);
  });
});

describe("session identity", () => {
  it("gives separate conversations different session ids", async () => {
    await send(goProvider(), "deepseek-v4.1-flash", "conv-a");
    await send(goProvider(), "deepseek-v4.1-flash", "conv-b");

    const [a, b] = recorded.map((r) => r.headers.get(SESSION_HEADER));
    expect(a).toBe("conv-a");
    expect(b).toBe("conv-b");
    expect(a).not.toBe(b);
  });

  it("keeps one id across turns, even though each turn builds a fresh model", async () => {
    // The agent host rebuilds the transport (and model) for every user turn,
    // always with the same persisted conversation id.
    for (let turn = 0; turn < 3; turn++) {
      await send(goProvider(), "deepseek-v4.1-flash", "conv-a");
    }
    const ids = new Set(recorded.map((r) => r.headers.get(SESSION_HEADER)));
    expect(recorded).toHaveLength(3);
    expect(ids).toEqual(new Set(["conv-a"]));
  });

  it("keeps one id across every step of an agent tool loop", async () => {
    responder = (n) =>
      Response.json(n === 1 ? TOOL_CALL_COMPLETION : CHAT_COMPLETION);
    const lm = await goProvider().createLanguageModel(
      { apiKey: FAKE_KEY },
      "deepseek-v4.1-flash",
      conversationRequestContext("conv-a"),
    );

    const result = await generateText({
      model: lm,
      prompt: "use the tool",
      tools: {
        echo: tool({
          description: "echo",
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => text,
        }),
      },
      stopWhen: stepCountIs(5),
      maxRetries: 0,
    });

    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(recorded).toHaveLength(result.steps.length);
    expect(
      recorded.every((r) => r.headers.get(SESSION_HEADER) === "conv-a"),
    ).toBe(true);
  });

  it("keeps the same id when the SDK retries a failed request", async () => {
    responder = (n) =>
      n === 1
        ? Response.json(
            { error: { message: "overloaded" } },
            { status: 503, headers: { "retry-after-ms": "5" } },
          )
        : Response.json(CHAT_COMPLETION);

    await send(goProvider(), "deepseek-v4.1-flash", "conv-a", { maxRetries: 2 });

    expect(recorded.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(recorded.map((r) => r.headers.get(SESSION_HEADER))),
    ).toEqual(new Set(["conv-a"]));
  });

  it("preserves the id after a reload (fresh module instances, same persisted conversation id)", async () => {
    // The session id is the conversation id, which the chat DB persists. A
    // reload discards every module-level object; rebuilding from scratch with
    // the stored conversation id must land on the identical header.
    await send(goProvider(), "deepseek-v4.1-flash", "conv-persisted");
    const before = recorded[0].headers.get(SESSION_HEADER);
    // Guard against comparing null with null if the header were ever dropped.
    expect(before).toBe("conv-persisted");

    vi.resetModules();
    const fresh = await import("../from-models-dev");
    const freshCtx = await import("@/registry/providers/request-context");
    const def = fresh.fromModelsDevProvider(OPENCODE_GO, undefined);
    const lm = await def.createLanguageModel(
      { apiKey: FAKE_KEY },
      "deepseek-v4.1-flash",
      freshCtx.conversationRequestContext("conv-persisted"),
    );
    await generateText({ model: lm, prompt: "hi", maxRetries: 0 });

    expect(recorded).toHaveLength(2);
    expect(recorded[1].headers.get(SESSION_HEADER)).toBe("conv-persisted");
  });

  it("uses the conversation id itself as the session id", () => {
    expect(conversationRequestContext("conv-a")).toEqual({ sessionId: "conv-a" });
    expect(conversationRequestContext(undefined)).toEqual({});
    expect(conversationRequestContext("")).toEqual({});
  });

  it("mints a distinct id for each one-off request, never reusing one", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => oneShotRequestContext().sessionId),
    );
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("other providers", () => {
  it("does not send the header from a same-SDK provider with another id", async () => {
    const other = fromModelsDevProvider(OTHER_COMPATIBLE, undefined);
    await send(other, "deepseek-v4.1-flash", "conv-a");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(recorded[0].headers.has(SESSION_HEADER)).toBe(false);
  });

  it("does not send the header to OpenCode Zen", async () => {
    const zen = fromModelsDevProvider(OPENCODE_ZEN, undefined);
    await send(zen, "deepseek-v4-pro", "conv-a");

    expect(recorded[0].headers.has(SESSION_HEADER)).toBe(false);
  });

  it("leaves the Anthropic provider's request unchanged", async () => {
    const anthropic = fromModelsDevProvider(
      {
        id: "anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        env: ["ANTHROPIC_API_KEY"],
        models: { "claude-haiku-4-5": model("claude-haiku-4-5") },
      },
      undefined,
    );
    await send(anthropic, "claude-haiku-4-5", "conv-a");

    expect(recorded[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(recorded[0].headers.has(SESSION_HEADER)).toBe(false);
    expect(
      recorded[0].headers.get("anthropic-dangerous-direct-browser-access"),
    ).toBe("true");
  });
});

describe("the bundled catalog snapshot", () => {
  it("wires OpenCode Go's per-model protocols and the header from real data", async () => {
    const { providers } = await import("@/registry/providers");
    const go = providers.find((p) => p.id === "opencode-go");
    expect(go, "opencode-go missing from the registry").toBeDefined();

    await send(go!, "deepseek-v4-flash", "conv-snap");
    await send(go!, "qwen3.8-max", "conv-snap");

    expect(recorded.map((r) => r.url.split("/").slice(-1)[0])).toEqual([
      "completions",
      "messages",
    ]);
    expect(
      recorded.every((r) => r.headers.get(SESSION_HEADER) === "conv-snap"),
    ).toBe(true);
  });

  it("keeps the picker order: OpenCode Go gains no curated-provider promotion", async () => {
    const { providers } = await import("@/registry/providers");
    const { QUIRKS } = await import("../quirks");
    // Presence in QUIRKS sorts a provider to the top of the picker.
    expect(QUIRKS["opencode-go"]).toBeUndefined();
    expect(providers.some((p) => p.id === "opencode-go")).toBe(true);
  });
});
