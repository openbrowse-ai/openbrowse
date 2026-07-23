import { deserializePart } from "@/hooks/useAgentChat";
import { describe, expect, it } from "vitest";
import type { AgentUIMessage } from "../../types";
import { rewriteForLLM } from "../compacting-transport";
import { serializeParts } from "../serialize-parts";

/**
 * Option-C contract for chat/tab mentions: the resolved mention context is
 * carried on a user message as a `data-mention-context` part (never inline
 * text), so the composer bubble renders clean. The transport is the single
 * injection point — `rewriteForLLM` turns that data part into a real text
 * part so the model actually sees the mentioned tabs'/chats' content.
 */

const MENTION_BLOCK =
  "\n\n-----\n\n<Mentioned chats>\n[Chat: Hello](chat)\nUser: hi\n</Mentioned chats>";

function userWithMention(id: string): AgentUIMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "what did we discuss #[Hello](chat:c1)" },
      { type: "data-mention-context", data: { text: MENTION_BLOCK } },
    ],
  } as unknown as AgentUIMessage;
}

function textParts(m: AgentUIMessage): string[] {
  return m.parts
    .filter((p) => (p as { type: string }).type === "text")
    .map((p) => (p as { text: string }).text);
}

describe("rewriteForLLM — mention context injection", () => {
  it("substitutes data-mention-context into a text part for the model", () => {
    const out = rewriteForLLM([userWithMention("m1")]);
    expect(out).toHaveLength(1);

    // No data part survives to the model view...
    expect(
      out[0].parts.some(
        (p) => (p as { type: string }).type === "data-mention-context",
      ),
    ).toBe(false);

    // ...instead its text is present as a plain text part.
    const texts = textParts(out[0]);
    expect(texts).toContain(MENTION_BLOCK);
    // The user's typed message (with the chip token) is preserved too.
    expect(texts.some((t) => t.includes("what did we discuss"))).toBe(true);
  });

  it("leaves messages without a mention part untouched (same reference)", () => {
    const plain = {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as AgentUIMessage;
    const out = rewriteForLLM([plain]);
    expect(out[0].parts).toBe(plain.parts);
  });
});

describe("data-mention-context persistence round-trip", () => {
  it("serializes and deserializes without loss", () => {
    const serialized = serializeParts(userWithMention("m1").parts);
    const mention = serialized.find(
      (p) => p.type === "data-mention-context",
    );
    expect(mention).toEqual({
      type: "data-mention-context",
      data: { text: MENTION_BLOCK },
    });

    const back = deserializePart(mention!);
    expect(back).toEqual({
      type: "data-mention-context",
      data: { text: MENTION_BLOCK },
    });
  });
});
