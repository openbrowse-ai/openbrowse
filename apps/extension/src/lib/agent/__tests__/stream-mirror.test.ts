import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  applyStreamSnapshot,
  mergeChatDbWithLocal,
  shouldRecoverFromStuckStreaming,
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

describe("stream-mirror: mergeChatDbWithLocal", () => {
  /**
   * Regression for the "side panel out of sync after Stop + resend" bug.
   *
   * Scenario: user clicks Stop mid-Navigate, then submits a new message.
   * Local in-memory state contains the aborted assistant message with
   * partial chunks, plus the new user message, plus a streaming new
   * assistant message. chatDb contains the healed aborted message
   * (written by `healPendingTools` in the queue/handleSubmit path) and
   * the new user message. The new assistant message hasn't been persisted
   * yet (SW persister flushes per step).
   *
   * We must produce a merged transcript that:
   *   - Replaces local assistant-1 with chatDb's healed version (since
   *     chatDb is post-heal authoritative).
   *   - Preserves the in-flight new assistant message (local-only — would
   *     be CLOBBERED by a naive `setMessages(dbMsgs)`).
   */
  interface Msg2 {
    id: string;
    role: string;
    parts: { type: string; text?: string; state?: string }[];
  }

  it("replaces stale local messages with chatDb versions when ids match", () => {
    const localStaleAssistant1: Msg2 = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "partial" }],
    };
    const local: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      localStaleAssistant1,
    ];
    const healedAssistant1: Msg2 = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "partial" },
        { type: "tool-navigate", state: "output-error" },
      ],
    };
    const db: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      healedAssistant1,
    ];
    const merged = mergeChatDbWithLocal(db, local);
    expect(merged).toEqual(db);
    // a1 is the HEALED one from db, not the stale local one.
    expect(merged[1]).toBe(healedAssistant1);
  });

  it("preserves local-only tail messages (new user + in-flight assistant) not yet in chatDb", () => {
    const local: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "old partial" }] },
      // New turn — local only, in-flight:
      { id: "u2", role: "user", parts: [{ type: "text", text: "new msg" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "streaming..." }] },
    ];
    const db: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "healed" }] },
    ];
    const merged = mergeChatDbWithLocal(db, local);
    expect(merged.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    // a1 is healed (from db); u2 and a2 are preserved (from local).
    expect(merged[1].parts).toEqual([{ type: "text", text: "healed" }]);
    expect(merged[2].parts).toEqual([{ type: "text", text: "new msg" }]);
    expect(merged[3].parts).toEqual([{ type: "text", text: "streaming..." }]);
  });

  it("user-reported scenario: Stop+resend ends with consistent side panel transcript", () => {
    // The exact failing path: local state has more assistant content
    // than chatDb (chunks kept arriving after abort intent), chatDb
    // has the healed snapshot, and a new user message is in flight.
    const local: Msg2[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "scrape news" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "I will navigate..." },
          { type: "tool-navigate", state: "input-streaming" }, // stale
          { type: "text", text: "EXTRA TEXT THE OTHER SURFACES DON'T HAVE" },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "actually use subagents" }] },
      // No a2 yet — SW hasn't started R2 emitting chunks.
    ];
    const db: Msg2[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "scrape news" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "I will navigate..." },
          { type: "tool-navigate", state: "output-error" }, // healed by handleSubmit
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "actually use subagents" }] },
    ];
    const merged = mergeChatDbWithLocal(db, local);
    expect(merged).toEqual(db);
    // The "EXTRA TEXT" is gone — local stale a1 is replaced by db's healed version.
    const a1Texts = merged[1].parts
      .filter((p) => p.type === "text")
      .map((p) => p.text);
    expect(a1Texts).not.toContain(
      "EXTRA TEXT THE OTHER SURFACES DON'T HAVE",
    );
  });

  it("appends in-flight assistant for next turn (a2) when db hasn't seen it yet", () => {
    const local: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "old" }] },
      { id: "u2", role: "user", parts: [] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "new streaming" }] },
    ];
    const db: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "healed" }] },
      { id: "u2", role: "user", parts: [] },
      // No a2 yet.
    ];
    const merged = mergeChatDbWithLocal(db, local);
    expect(merged.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(merged[3].parts[0].text).toBe("new streaming");
  });

  it("returns dbMessages unchanged when local has no extra messages", () => {
    const db: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
    ];
    const local: Msg2[] = db.map((m) => ({ ...m })); // same ids
    const merged = mergeChatDbWithLocal(db, local);
    expect(merged).toEqual(db);
  });

  it("returns local unchanged when db is empty", () => {
    const local: Msg2[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];
    const merged = mergeChatDbWithLocal([], local);
    expect(merged).toEqual(local);
  });

  it("does not mutate inputs", () => {
    const db: Msg2[] = [{ id: "u1", role: "user", parts: [] }];
    const local: Msg2[] = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [] },
    ];
    mergeChatDbWithLocal(db, local);
    expect(db).toHaveLength(1);
    expect(local).toHaveLength(2);
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

describe("stream-mirror: shouldRecoverFromStuckStreaming", () => {
  /**
   * Watchdog decision: should the renderer recover from a stuck-streaming
   * state by re-hydrating from chatDb and resetting Chat status to ready?
   *
   * The initiator surface (side panel, etc.) drives the agent run via
   * RemoteChatTransport. The AI SDK's Chat instance stays in `streaming`
   * status while the chunk stream is open. If the SW emits AGENT_RUN_DONE
   * but the port-side mechanism that delivers it gets disrupted, the
   * Chat stays stuck in `streaming` indefinitely. Symptoms:
   *
   *   - queue auto-flush gates on `status === "ready"` so queued messages
   *     never drain
   *   - UI shows "Navigating..." or similar tool-running indicator forever
   *   - chatDb's last assistant message is already in terminal state
   *     (SW persister flushed everything before the disrupted DONE)
   *
   * Recovery: when the watchdog detects this condition, force the
   * renderer to converge with chatDb's state and unblock the queue.
   *
   * The check intentionally returns false when:
   *   - status is not streaming/submitted (no stuck state to recover)
   *   - the last activity was recent (not stuck — just slow)
   *   - the last assistant message has an `input-streaming` tool part
   *     (genuinely in flight, not stuck)
   *   - the last assistant message has an `approval-requested` part
   *     (intentional pause; user must act)
   */
  type RecoverArgs = Parameters<typeof shouldRecoverFromStuckStreaming>[0];

  function baseArgs(overrides: Partial<RecoverArgs> = {}): RecoverArgs {
    return {
      status: "streaming",
      lastActivityMs: 1_000_000,
      now: 1_000_000 + 35_000, // 35s since last activity
      idleThresholdMs: 30_000,
      dbLastAssistantParts: [{ type: "text", text: "Done." }],
      ...overrides,
    };
  }

  it("recovers when status is streaming and idle for longer than threshold and db is terminal", () => {
    expect(shouldRecoverFromStuckStreaming(baseArgs())).toBe(true);
  });

  it("recovers when status is submitted (queued but never advanced)", () => {
    expect(
      shouldRecoverFromStuckStreaming(baseArgs({ status: "submitted" })),
    ).toBe(true);
  });

  it("does NOT recover when status is ready (run finished cleanly)", () => {
    expect(
      shouldRecoverFromStuckStreaming(baseArgs({ status: "ready" })),
    ).toBe(false);
  });

  it("does NOT recover when status is error", () => {
    expect(
      shouldRecoverFromStuckStreaming(baseArgs({ status: "error" })),
    ).toBe(false);
  });

  it("does NOT recover when last activity was recent (< threshold)", () => {
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({ now: 1_000_000 + 10_000 }), // only 10s elapsed
      ),
    ).toBe(false);
  });

  it("does NOT recover when last activity == threshold exactly (open interval)", () => {
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({ now: 1_000_000 + 30_000 }), // exactly 30s
      ),
    ).toBe(false);
  });

  it("does NOT recover when db has no messages yet (don't clobber an empty turn)", () => {
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({ dbLastAssistantParts: undefined }),
      ),
    ).toBe(false);
  });

  it("does NOT recover when db's last assistant has an input-streaming tool part", () => {
    // A tool's input is still being built. The model genuinely is mid-flight.
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({
          dbLastAssistantParts: [
            { type: "text", text: "Working..." },
            {
              type: "tool-navigate",
              state: "input-streaming",
            } as { type: string; state?: string },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT recover when db's last assistant has an approval-requested tool part", () => {
    // Approval-requested is an INTENTIONAL pause. The user has to act.
    // Recovering here would discard the approval prompt.
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({
          dbLastAssistantParts: [
            { type: "text", text: "About to navigate" },
            {
              type: "tool-navigate",
              state: "approval-requested",
            } as { type: string; state?: string },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT recover when db's last assistant has an input-available tool part", () => {
    // input-available means the model finished building the tool input
    // and the tool execution has just been dispatched. Converging now
    // would discard the pending tool call.
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({
          dbLastAssistantParts: [
            { type: "text", text: "Calling tool..." },
            {
              type: "tool-navigate",
              state: "input-available",
            } as { type: string; state?: string },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT recover when db's last assistant has an approval-responded tool part", () => {
    // approval-responded is the brief window after the user clicks
    // approve/deny but before the SDK has produced the post-approval
    // tool result. Converging here would discard the in-flight resume.
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({
          dbLastAssistantParts: [
            { type: "text", text: "Approved, executing..." },
            {
              type: "tool-navigate",
              state: "approval-responded",
            } as { type: string; state?: string },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("recovers when db has terminal tool parts (output-available, output-error, output-denied)", () => {
    const terminalStates = [
      "output-available",
      "output-error",
      "output-denied",
    ];
    for (const state of terminalStates) {
      expect(
        shouldRecoverFromStuckStreaming(
          baseArgs({
            dbLastAssistantParts: [
              {
                type: "tool-navigate",
                state,
              } as { type: string; state?: string },
            ],
          }),
        ),
      ).toBe(true);
    }
  });

  it("recovers when last activity is well past threshold (60s)", () => {
    expect(
      shouldRecoverFromStuckStreaming(
        baseArgs({ now: 1_000_000 + 60_000 }),
      ),
    ).toBe(true);
  });
});
