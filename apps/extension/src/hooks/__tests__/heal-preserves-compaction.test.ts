import { describe, expect, it } from "vitest";
import { healPendingTools } from "@/lib/agent/heal-pending-tools";
import type { AgentUIMessage } from "@/lib/types";

/**
 * Regression test for the compact-then-send + stranded-tool bug.
 *
 * In the compact-then-send flow (`/compact some text`), `compactNow()`
 * appends a compaction marker + summary to the chat, then `handleSubmit`
 * runs its `healPendingTools` pass and `setMessages(healed)` writes the
 * result back. If that heal pass operated on a STALE message list (the
 * pre-compaction closure), `healed` would lack the marker/summary and
 * `setMessages` would drop them — so the transport would ship the full
 * un-compacted history to the model.
 *
 * The fix reads `messagesRef.current` (the post-compaction list) for the
 * heal pass. This test locks in the property that makes that safe: healing
 * a stranded tool must PRESERVE a compaction marker + summary elsewhere in
 * the list (it only rewrites the offending tool part, nothing else).
 */

function userText(id: string, text: string): AgentUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as AgentUIMessage;
}

function strandedToolAssistant(id: string): AgentUIMessage {
  // A tool call left in a non-terminal state (input-available, no output) —
  // this is what `healPendingTools` rewrites to output-error.
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "navigate",
        toolCallId: "call-stranded",
        state: "input-available",
        input: { url: "https://example.com" },
      },
    ],
  } as unknown as AgentUIMessage;
}

function compactionMarker(id: string): AgentUIMessage {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "data-compaction",
        data: { auto: false, tailStartMessageId: undefined },
      },
    ],
  } as unknown as AgentUIMessage;
}

function summaryAssistant(id: string, text: string): AgentUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as unknown as AgentUIMessage;
}

describe("healPendingTools — preserves compaction event", () => {
  it("heals a stranded tool while keeping the compaction marker + summary", () => {
    // Post-compaction layout: an earlier stranded tool, then the
    // compaction marker + summary that compactNow() appended.
    const messages: AgentUIMessage[] = [
      userText("m1", "do a thing"),
      strandedToolAssistant("m2"),
      compactionMarker("m3"),
      summaryAssistant("m4", "SUMMARY: did things"),
    ];

    const { healed, healedMessages } = healPendingTools(
      messages,
      "Superseded by new user message",
    );

    // The stranded tool was actually healed (otherwise this test proves
    // nothing about the dangerous setMessages path).
    expect(healedMessages.length).toBeGreaterThan(0);

    // Same length — healing rewrites parts in place, never drops messages.
    expect(healed.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);

    // The compaction marker survives intact.
    const marker = healed.find((m) => m.id === "m3");
    expect(
      marker?.parts.some((p) => (p as { type: string }).type === "data-compaction"),
    ).toBe(true);

    // The summary survives intact.
    const summary = healed.find((m) => m.id === "m4");
    expect(
      (summary?.parts.find((p) => (p as { type: string }).type === "text") as
        | { text: string }
        | undefined)?.text,
    ).toContain("SUMMARY");

    // The stranded tool part is now in a terminal state.
    const toolMsg = healed.find((m) => m.id === "m2");
    const toolPart = toolMsg?.parts[0] as { state: string };
    expect(["output-error", "output-denied"]).toContain(toolPart.state);
  });

  it("returns the list unchanged when there are no stranded tools", () => {
    const messages: AgentUIMessage[] = [
      userText("m1", "hi"),
      summaryAssistant("m2", "hello"),
      compactionMarker("m3"),
      summaryAssistant("m4", "SUMMARY"),
    ];
    const { healed, healedMessages } = healPendingTools(messages, "reason");
    expect(healedMessages.length).toBe(0);
    expect(healed).toBe(messages);
  });
});
