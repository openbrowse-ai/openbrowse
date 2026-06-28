import { describe, expect, it } from "vitest";
import { computeShowThinking } from "../compute-show-thinking";

/**
 * Regression for "two blue sparkles on viewer surfaces during streaming".
 *
 * Reproduces the four surface/state quadrants the indicator gate must
 * handle correctly. The old gate `isLoading && !hookIsStreaming`
 * passed (initiator-submitted, initiator-streaming, viewer-pre-stream)
 * but FAILED the (viewer-during-stream) quadrant, double-mounting the
 * indicator next to the assistant row's own `<GeneratingIndicator>`.
 *
 * Each test exercises the structural invariant: the trailing
 * `<ThinkingIndicator>` shows iff a run is active AND the last
 * message in the visible list is not yet an assistant.
 */

const user = (id: string) => ({ id, role: "user" as const });
const assistant = (id: string) => ({ id, role: "assistant" as const });

describe("computeShowThinking", () => {
  it("returns false when nothing is loading (idle list)", () => {
    expect(computeShowThinking(false, [])).toBe(false);
    expect(computeShowThinking(false, [user("u1"), assistant("a1")])).toBe(
      false,
    );
  });

  it("INITIATOR: submitted, no chunks yet — shows indicator (gap filler)", () => {
    // Just after Send: user message in list, no assistant yet,
    // useChat.status === "submitted" so isLoading is true.
    expect(computeShowThinking(true, [user("u1")])).toBe(true);
  });

  it("INITIATOR: streaming, assistant row exists — hides indicator", () => {
    // First chunk arrived, assistant row created. Its own
    // <GeneratingIndicator> covers the loading state; the trailing
    // indicator must NOT also mount.
    expect(computeShowThinking(true, [user("u1"), assistant("a1")])).toBe(
      false,
    );
  });

  it("VIEWER: SW run live, no snapshot yet — shows indicator (gap filler)", () => {
    // Viewer surface: isLoading is true via isAgentActiveGlobally even
    // though useChat.status is "ready" locally. No STREAM_PARTS has
    // produced an assistant row yet, so the user's last message is
    // alone — show the gap filler.
    expect(computeShowThinking(true, [user("u1")])).toBe(true);
  });

  it("VIEWER: SW run live, assistant snapshot mirrored — hides indicator (regression)", () => {
    // The exact bug: on the viewer the SW broadcasts STREAM_PARTS,
    // which mirrors an assistant row into the local message list. The
    // row gets `isStreaming=true` (because the cross-tab signal is
    // active) and renders its own pulsing blue sparkle. The trailing
    // indicator MUST stay off so the user sees ONE sparkle, not two.
    expect(computeShowThinking(true, [user("u1"), assistant("a1")])).toBe(
      false,
    );
  });

  it("CONTINUATION: history with old assistants + new user msg — shows indicator", () => {
    // Critical: `messages.some(role === "assistant")` would be the
    // wrong predicate here — earlier turns left assistant rows in
    // history. The right predicate is "the LAST message isn't an
    // assistant", which is true for a freshly-submitted continuation.
    const list = [
      user("u1"),
      assistant("a1"),
      user("u2"), // new turn, no assistant yet
    ];
    expect(computeShowThinking(true, list)).toBe(true);
  });

  it("CONTINUATION: new assistant row exists — hides indicator", () => {
    const list = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"), // new turn's row mounted
    ];
    expect(computeShowThinking(true, list)).toBe(false);
  });

  it("empty list with isLoading true — shows indicator (defensive)", () => {
    // A racey moment when the conversation just opened and Send fired
    // before the persisted messages hydrated. `lastMessage?.role` is
    // undefined; we want to show the indicator (gap is real).
    expect(computeShowThinking(true, [])).toBe(true);
  });
});
