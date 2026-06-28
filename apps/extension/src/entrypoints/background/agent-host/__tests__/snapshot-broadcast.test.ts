import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_MIRROR_THROTTLE_MS } from "@/lib/constants";
import type { SerializedUIPart } from "@/lib/agent/message-types";
import { createSnapshotBroadcaster } from "../snapshot-broadcast";

/**
 * The snapshot broadcaster lifts the renderer-side throttled broadcast
 * (formerly at useAgentChat.ts:1290-1319) into the SW agent host. Same
 * semantics:
 *
 *   - first call emits immediately (leading edge);
 *   - subsequent calls within STREAM_MIRROR_THROTTLE_MS are coalesced;
 *   - a trailing-edge emit fires once after the throttle window closes,
 *     so the final partial state always lands;
 *   - emitted snapshots carry a monotonically increasing `seq` per
 *     broadcaster instance so viewers can drop out-of-order frames.
 *
 * The broadcast itself goes through `chrome.runtime.sendMessage`; tests
 * stub it via `vi.spyOn`.
 */

function makeParts(text: string): SerializedUIPart[] {
  // Shape matches `SerializedUIPart` for a text part. The broadcaster
  // does not interpret part contents — it only forwards them — so any
  // shape that satisfies SerializedUIPart works.
  return [{ type: "text", text } as unknown as SerializedUIPart];
}

describe("snapshot broadcaster", () => {
  let sendMessageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Use spyOn so vi.restoreAllMocks() cleanly reverts the mock in
    // afterEach — replacing the field on the shared chrome stub
    // (formerly: `chrome.runtime.sendMessage = sendMessageSpy`) would
    // leak across files because `vi.unstubAllGlobals()` doesn't restore
    // nested property assignments.
    sendMessageSpy = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits the first snapshot immediately (leading edge)", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("hi") });

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const payload = sendMessageSpy.mock.calls[0]![0];
    expect(payload).toMatchObject({
      type: "STREAM_PARTS",
      conversationId: "conv-A",
      messageId: "m-1",
      seq: 1,
    });
  });

  it("coalesces a burst of emits within the throttle window into one trailing-edge call", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("a") }); // immediate
    bc.emit({ messageId: "m-1", parts: makeParts("ab") }); // suppressed
    bc.emit({ messageId: "m-1", parts: makeParts("abc") }); // suppressed
    expect(sendMessageSpy).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(STREAM_MIRROR_THROTTLE_MS);

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    const trailing = sendMessageSpy.mock.calls[1]![0];
    expect(trailing).toMatchObject({
      type: "STREAM_PARTS",
      conversationId: "conv-A",
      messageId: "m-1",
      seq: 2,
    });
    // Trailing edge should carry the LATEST parts, not the original.
    expect(JSON.stringify(trailing.parts)).toContain("abc");
  });

  it("does not fire a trailing edge when no further emits arrive after the leading call", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("only") });

    vi.advanceTimersByTime(STREAM_MIRROR_THROTTLE_MS * 5);

    // Only the leading-edge call should exist.
    expect(sendMessageSpy).toHaveBeenCalledOnce();
  });

  it("emits immediately again after the throttle window has elapsed without queued work", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("a") });

    vi.advanceTimersByTime(STREAM_MIRROR_THROTTLE_MS + 1);

    bc.emit({ messageId: "m-1", parts: makeParts("b") });
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
  });

  it("increments seq monotonically across emits", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("a") });
    vi.advanceTimersByTime(STREAM_MIRROR_THROTTLE_MS + 1);
    bc.emit({ messageId: "m-1", parts: makeParts("b") });
    vi.advanceTimersByTime(STREAM_MIRROR_THROTTLE_MS + 1);
    bc.emit({ messageId: "m-1", parts: makeParts("c") });

    const seqs = sendMessageSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { seq: number }).seq,
    );
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("done() flushes any pending trailing emit then broadcasts STREAM_DONE", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("a") });
    bc.emit({ messageId: "m-1", parts: makeParts("ab") }); // pending
    expect(sendMessageSpy).toHaveBeenCalledOnce();

    bc.done();

    // First call: leading edge. Second: flushed trailing-edge with latest
    // parts. Third: STREAM_DONE.
    expect(sendMessageSpy).toHaveBeenCalledTimes(3);
    expect(sendMessageSpy.mock.calls[1]![0].type).toBe("STREAM_PARTS");
    expect(JSON.stringify(sendMessageSpy.mock.calls[1]![0].parts)).toContain(
      "ab",
    );
    expect(sendMessageSpy.mock.calls[2]![0]).toMatchObject({
      type: "STREAM_DONE",
      conversationId: "conv-A",
    });
  });

  it("done() with no pending emit just broadcasts STREAM_DONE", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.emit({ messageId: "m-1", parts: makeParts("a") });
    vi.advanceTimersByTime(STREAM_MIRROR_THROTTLE_MS + 1);

    bc.done();
    // One STREAM_PARTS (leading edge), then STREAM_DONE. No trailing.
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(sendMessageSpy.mock.calls[1]![0].type).toBe("STREAM_DONE");
  });

  it("done() is idempotent", () => {
    const bc = createSnapshotBroadcaster("conv-A");
    bc.done();
    bc.done();
    expect(sendMessageSpy).toHaveBeenCalledOnce();
  });

  it("two broadcasters for different conversations have independent seq counters", () => {
    const bcA = createSnapshotBroadcaster("conv-A");
    const bcB = createSnapshotBroadcaster("conv-B");
    bcA.emit({ messageId: "m-1", parts: makeParts("a") });
    bcB.emit({ messageId: "m-1", parts: makeParts("b") });

    const calls = sendMessageSpy.mock.calls.map((c: unknown[]) => ({
      conv: (c[0] as { conversationId: string }).conversationId,
      seq: (c[0] as { seq: number }).seq,
    }));
    expect(calls).toEqual([
      { conv: "conv-A", seq: 1 },
      { conv: "conv-B", seq: 1 },
    ]);
  });
});
