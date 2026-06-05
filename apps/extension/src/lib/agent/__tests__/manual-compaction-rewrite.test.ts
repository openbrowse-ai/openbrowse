import { describe, expect, it } from "vitest";
import { rewriteForLLM } from "../compacting-transport";
import { COMPACTION_USER_PROMPT } from "../compaction";
import type { AgentUIMessage } from "../../types";

/**
 * Regression test for the manual `/compact` model view.
 *
 * A user-typed `/compact` summarizes the entire conversation and keeps NO
 * verbatim tail. Earlier, `selectTailForManual` anchored the tail at the
 * last user message, so `rewriteForLLM` re-included that whole final
 * exchange verbatim — the model still "remembered everything" despite the
 * divider. With the summary-only behavior (`tailStartMessageId` undefined),
 * the model must see only: the substituted marker prompt, the summary, and
 * any turns that came *after* the compaction.
 */

function u(id: string, text: string): AgentUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as AgentUIMessage;
}
function a(id: string, text: string): AgentUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}
function compactionMarker(id: string): AgentUIMessage {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "data-compaction",
        // Manual compaction: no verbatim tail anchor.
        data: { auto: false, tailStartMessageId: undefined },
      },
    ],
  } as unknown as AgentUIMessage;
}

function text(m: AgentUIMessage): string | undefined {
  return (m.parts.find((p) => (p as { type: string }).type === "text") as
    | { text: string }
    | undefined)?.text;
}

describe("rewriteForLLM — manual /compact (summary-only)", () => {
  it("drops all pre-compaction messages from the model view", () => {
    const pre: AgentUIMessage[] = [
      u("m1", "write me a poem"),
      a("m2", "poem 1"),
      u("m3", "another poem"),
      a("m4", "poem 2"),
      u("m5", "what did we do so far?"),
      a("m6", "structured summary of poems"),
    ];
    const marker = compactionMarker("m7");
    const summary = a("m8", "SUMMARY: wrote two poems, greeted user");
    const newQ = u("m9", "hi what messages did we exchange rn");

    const sent = rewriteForLLM([...pre, marker, summary, newQ]);
    const ids = sent.map((m) => m.id);

    // None of the pre-compaction messages survive into the model view.
    for (const m of pre) {
      expect(ids).not.toContain(m.id);
    }

    // Exactly: marker (substituted), summary, the new question.
    expect(ids).toEqual(["m7", "m8", "m9"]);

    // The marker's CompactionPart is substituted with the synthetic prompt.
    expect(text(sent[0])).toBe(COMPACTION_USER_PROMPT);
    expect(text(sent[1])).toContain("SUMMARY");
    expect(text(sent[2])).toBe("hi what messages did we exchange rn");
  });
});
