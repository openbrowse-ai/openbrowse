import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  applyStreamSnapshot,
  SeqGuard,
  isStreamPartsMessage,
  isStreamDoneMessage,
  broadcastStreamParts,
  broadcastStreamDone,
} from "../stream-mirror";
import { RUNTIME_MESSAGES } from "@/lib/constants";

interface Msg {
  id: string;
  role: string;
  parts: { type: string; text?: string }[];
}

describe("stream-mirror: applyStreamSnapshot", () => {
  it("appends when the message id is not present", () => {
    const base: Msg[] = [{ id: "u1", role: "user", parts: [] }];
    const snap: Msg = { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] };
    const next = applyStreamSnapshot(base, snap);
    expect(next.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("replaces in place when the message id already exists", () => {
    const base: Msg[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "h" }] },
    ];
    const snap: Msg = { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] };
    const next = applyStreamSnapshot(base, snap);
    expect(next).toHaveLength(2);
    expect(next[1].parts[0].text).toBe("hello");
  });

  it("does not mutate the input array", () => {
    const base: Msg[] = [{ id: "a1", role: "assistant", parts: [] }];
    const snap: Msg = { id: "a1", role: "assistant", parts: [{ type: "text", text: "x" }] };
    applyStreamSnapshot(base, snap);
    expect(base[0].parts).toEqual([]);
  });
});

describe("stream-mirror: SeqGuard", () => {
  it("applies strictly increasing seqs and drops stale/equal ones", () => {
    const g = new SeqGuard();
    expect(g.shouldApply("a1", 1)).toBe(true);
    expect(g.shouldApply("a1", 2)).toBe(true);
    expect(g.shouldApply("a1", 2)).toBe(false); // equal -> stale
    expect(g.shouldApply("a1", 1)).toBe(false); // out of order
    expect(g.shouldApply("a1", 3)).toBe(true);
  });

  it("tracks seqs independently per message id", () => {
    const g = new SeqGuard();
    expect(g.shouldApply("a1", 5)).toBe(true);
    expect(g.shouldApply("a2", 1)).toBe(true);
    expect(g.shouldApply("a2", 2)).toBe(true);
    expect(g.shouldApply("a1", 5)).toBe(false);
  });

  it("reset clears tracked seqs", () => {
    const g = new SeqGuard();
    g.shouldApply("a1", 9);
    g.reset();
    expect(g.shouldApply("a1", 1)).toBe(true);
  });
});

describe("stream-mirror: type guards", () => {
  it("recognizes a valid STREAM_PARTS message", () => {
    expect(
      isStreamPartsMessage({
        type: RUNTIME_MESSAGES.STREAM_PARTS,
        conversationId: "c1",
        messageId: "a1",
        parts: [],
        seq: 1,
      }),
    ).toBe(true);
  });

  it("rejects malformed STREAM_PARTS messages", () => {
    expect(isStreamPartsMessage(null)).toBe(false);
    expect(isStreamPartsMessage({ type: "OTHER" })).toBe(false);
    expect(
      isStreamPartsMessage({
        type: RUNTIME_MESSAGES.STREAM_PARTS,
        conversationId: "c1",
        messageId: "a1",
        parts: "nope",
        seq: 1,
      }),
    ).toBe(false);
  });

  it("recognizes STREAM_DONE", () => {
    expect(
      isStreamDoneMessage({
        type: RUNTIME_MESSAGES.STREAM_DONE,
        conversationId: "c1",
      }),
    ).toBe(true);
    expect(isStreamDoneMessage({ type: RUNTIME_MESSAGES.STREAM_PARTS })).toBe(
      false,
    );
  });
});

describe("stream-mirror: broadcasts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("broadcastStreamParts sends a STREAM_PARTS payload", () => {
    const send = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
    broadcastStreamParts({
      conversationId: "c1",
      messageId: "a1",
      parts: [{ type: "text", text: "hi" }],
      seq: 3,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RUNTIME_MESSAGES.STREAM_PARTS,
        conversationId: "c1",
        messageId: "a1",
        seq: 3,
      }),
    );
    vi.unstubAllGlobals();
  });

  it("broadcastStreamDone sends a STREAM_DONE payload", () => {
    const send = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
    broadcastStreamDone("c1");
    expect(send).toHaveBeenCalledWith({
      type: RUNTIME_MESSAGES.STREAM_DONE,
      conversationId: "c1",
    });
    vi.unstubAllGlobals();
  });

  it("does not throw when chrome.runtime is unavailable", () => {
    vi.stubGlobal("chrome", {});
    expect(() => broadcastStreamDone("c1")).not.toThrow();
    vi.unstubAllGlobals();
  });
});
