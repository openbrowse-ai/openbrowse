import { describe, expect, it } from "vitest";
import {
  agentModelGate,
  composerModelGate,
  isAgentCapableModel,
  isChatOnlyModel,
} from "../agent-capability";

describe("agentModelGate", () => {
  it("accepts a tool-capable model with a large context window", () => {
    const r = agentModelGate({
      capabilities: ["chat", "tools"],
      contextWindow: 131_072,
      maxOutputTokens: 4_096,
    });
    expect(r.ok).toBe(true);
    expect(
      isAgentCapableModel({
        capabilities: ["chat", "tools"],
        contextWindow: 131_072,
      }),
    ).toBe(true);
  });

  it("rejects a chat-only model as 'Chat only'", () => {
    const r = agentModelGate({
      capabilities: ["chat"],
      contextWindow: 131_072,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Chat only");
  });

  it("rejects Gemini Nano (chat-only, tiny window)", () => {
    const r = agentModelGate({
      capabilities: ["chat"],
      contextWindow: 4_096,
      maxOutputTokens: 2_048,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Chat only");
  });

  it("rejects a tool-capable model whose context window is too small", () => {
    // usable = 8192 - 4096 - 20000 < 0
    const r = agentModelGate({
      capabilities: ["tools"],
      contextWindow: 8_192,
      maxOutputTokens: 4_096,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Context too small");
  });

  it("gives an unknown context window the benefit of the doubt", () => {
    const r = agentModelGate({ capabilities: ["tools"] });
    expect(r.ok).toBe(true);
  });

  it("treats missing capabilities as chat-only", () => {
    const r = agentModelGate({});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Chat only");
  });
});

describe("composerModelGate", () => {
  it("lets a chat-only model be selected (advisory badge, not disabled)", () => {
    const r = composerModelGate({
      capabilities: ["chat"],
      contextWindow: 131_072,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Chat only");
    expect(r.allowSelect).toBe(true);
  });

  it("treats missing capabilities as selectable chat-only", () => {
    const r = composerModelGate({});
    expect(r.ok).toBe(false);
    expect(r.allowSelect).toBe(true);
  });

  it("passes an agent-capable model through unchanged", () => {
    const r = composerModelGate({
      capabilities: ["chat", "tools"],
      contextWindow: 131_072,
      maxOutputTokens: 4_096,
    });
    expect(r.ok).toBe(true);
    expect(r.allowSelect).toBeUndefined();
  });

  it("keeps a too-small tool-capable model hard-disabled (not selectable)", () => {
    const r = composerModelGate({
      capabilities: ["tools"],
      contextWindow: 8_192,
      maxOutputTokens: 4_096,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Context too small");
    expect(r.allowSelect).toBeUndefined();
  });
});

describe("isChatOnlyModel", () => {
  it("is true for a model without tool calling", () => {
    expect(isChatOnlyModel({ capabilities: ["chat"] })).toBe(true);
    expect(isChatOnlyModel({ capabilities: ["chat", "thinking"] })).toBe(true);
  });

  it("is false for a tool-capable model", () => {
    expect(isChatOnlyModel({ capabilities: ["chat", "tools"] })).toBe(false);
  });

  it("is independent of the context window", () => {
    // A tool-capable model with a tiny window is NOT chat-only — it is simply
    // gated out of the agent by `agentModelGate`. The two concepts are distinct.
    expect(
      isChatOnlyModel({ capabilities: ["tools"], contextWindow: 4_096 }),
    ).toBe(false);
  });

  it("treats an empty capability list as chat-only", () => {
    expect(isChatOnlyModel({ capabilities: [] })).toBe(true);
    expect(isChatOnlyModel({})).toBe(true);
  });

  it("must only be applied to a resolved model, never a missing one", () => {
    // Regression guard: the transport previously wrote
    //   !(modelDef?.capabilities ?? []).includes("tools")
    // which is `true` when `modelDef` is undefined, so an unresolved model
    // (e.g. a gateway/dynamic model absent from a provider's static list) was
    // silently routed to the chat-only path and lost every tool. Callers must
    // check `modelDef != null` first; this documents why.
    const unresolved: { capabilities?: string[] } | undefined = undefined;
    expect(isChatOnlyModel(unresolved ?? {})).toBe(true);
    expect(unresolved != null && isChatOnlyModel(unresolved)).toBe(false);
  });
});
