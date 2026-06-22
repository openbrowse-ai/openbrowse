import { describe, expect, it } from "vitest";
import { resolveToolPartState } from "../AssistantMessage";

describe("resolveToolPartState", () => {
  // ── Terminal states (unaffected by isStreaming) ─────────────────────

  it("maps output-available → 'result' with the original output payload", () => {
    const r = resolveToolPartState({
      state: "output-available",
      output: { ok: true, value: 42 },
    });
    expect(r.state).toBe("result");
    expect(r.result).toEqual({ ok: true, value: 42 });
  });

  it("output-available is unaffected by isStreaming flag", () => {
    const streaming = resolveToolPartState(
      { state: "output-available", output: { x: 1 } },
      { isStreaming: true },
    );
    const done = resolveToolPartState(
      { state: "output-available", output: { x: 1 } },
      { isStreaming: false },
    );
    expect(streaming.state).toBe("result");
    expect(done.state).toBe("result");
  });

  it("maps output-denied → 'denied' with no result", () => {
    const r = resolveToolPartState({ state: "output-denied" });
    expect(r.state).toBe("denied");
    expect(r.result).toBeUndefined();
  });

  it("maps output-error → 'errored' and synthesizes { error: errorText }", () => {
    const r = resolveToolPartState({
      state: "output-error",
      errorText: "Unknown tab handle \"t1\"",
    });
    expect(r.state).toBe("errored");
    expect(r.result).toEqual({ error: 'Unknown tab handle "t1"' });
    // A real failure → "failed" so the row shows the red "Failed" badge.
    expect(r.errorKind).toBe("failed");
  });

  it("output-error carrying the heal-interrupt text → 'errored' with errorKind 'interrupted'", () => {
    // healPendingTools / repairToolPart fold an orphaned tool part to
    // output-error with this exact text. It's an interruption, not a
    // genuine failure, so it must keep the muted "Interrupted" badge.
    const r = resolveToolPartState({
      state: "output-error",
      errorText: "Tool execution was interrupted before it returned a result",
    });
    expect(r.state).toBe("errored");
    expect(r.errorKind).toBe("interrupted");
  });

  it("output-error with missing errorText → 'errored' with a generic fallback message", () => {
    const r = resolveToolPartState({ state: "output-error" });
    expect(r.state).toBe("errored");
    expect((r.result as { error: string }).error).toMatch(/failed/i);
  });

  it("output-error with empty errorText → 'errored' with the generic fallback", () => {
    const r = resolveToolPartState({ state: "output-error", errorText: "" });
    expect(r.state).toBe("errored");
    expect((r.result as { error: string }).error).toMatch(/failed/i);
  });

  it("output-error with non-string errorText defensively → 'errored' fallback", () => {
    const r = resolveToolPartState({
      state: "output-error",
      errorText: 42 as unknown,
    });
    expect(r.state).toBe("errored");
    expect((r.result as { error: string }).error).toMatch(/failed/i);
  });

  it("output-error is unaffected by isStreaming flag", () => {
    const r = resolveToolPartState(
      { state: "output-error", errorText: "boom" },
      { isStreaming: true },
    );
    expect(r.state).toBe("errored");
  });

  // ── Non-terminal states while streaming (genuine in-flight) ─────────

  it.each([
    ["input-streaming"],
    ["input-available"],
    ["approval-requested"],
    ["approval-responded"],
  ])("non-terminal state '%s' + isStreaming:true → 'call' (genuinely in flight)", (state) => {
    const r = resolveToolPartState({ state }, { isStreaming: true });
    expect(r.state).toBe("call");
    expect(r.result).toBeUndefined();
  });

  it("unknown state + isStreaming:true → 'call'", () => {
    const r = resolveToolPartState({ state: "future-sdk-state" }, { isStreaming: true });
    expect(r.state).toBe("call");
  });

  // ── Non-terminal states once streaming has finished (orphans) ───────

  it("approval-responded + isStreaming:false → 'errored' with skipped-after-approval message", () => {
    // A malformed approval-responded (no `approval` payload) once streaming
    // has finished is a genuine orphan — the agent loop never picked the
    // call back up to run execute().
    const r = resolveToolPartState(
      { state: "approval-responded" },
      { isStreaming: false },
    );
    expect(r.state).toBe("errored");
    const err = (r.result as { error: string }).error;
    expect(err).toMatch(/skipped after approval/i);
    // Orphan, not a real failure → "interrupted".
    expect(r.errorKind).toBe("interrupted");
  });

  // ── APPROVED approval-responded is a resume point, not an orphan ─────
  // Regression guard for the "Interrupted" flash: right after the user
  // clicks Allow, the message is briefly not streaming but the tool hasn't
  // re-invoked execute() yet. An APPROVED, output-less approval-responded
  // must render as pending ('call'), not 'errored', mirroring needsHeal.

  it("approved approval-responded (output-less) + isStreaming:false → 'call' (pending, not errored)", () => {
    const r = resolveToolPartState(
      { state: "approval-responded", approval: { id: "ap1", approved: true } },
      { isStreaming: false },
    );
    expect(r.state).toBe("call");
    expect(r.result).toBeUndefined();
  });

  it("approved approval-responded that already has output → 'result' (output wins)", () => {
    const r = resolveToolPartState(
      {
        state: "approval-responded",
        approval: { id: "ap1", approved: true },
        output: { ok: true },
      },
      { isStreaming: false },
    );
    // output-available is not the state here, but the approved-pending
    // short-circuit must NOT apply once output exists; it falls through to
    // the orphan path. (In practice the SDK moves to output-available; this
    // guards the output-present guard in the short-circuit.)
    expect(r.state).toBe("errored");
  });

  it("DENIED approval-responded + isStreaming:false → 'denied' (terminal, matches healed output-denied)", () => {
    const r = resolveToolPartState(
      { state: "approval-responded", approval: { id: "ap1", approved: false } },
      { isStreaming: false },
    );
    expect(r.state).toBe("denied");
    expect(r.result).toBeUndefined();
  });

  it("DENIED approval-responded + isStreaming:true → 'denied' (not the pending 'running' row)", () => {
    // Regression guard: a declined tool (e.g. executePython) must NOT show
    // the blue pulsing "running" row while the stream is still live. It is
    // terminal the instant the user clicks Deny.
    const r = resolveToolPartState(
      { state: "approval-responded", approval: { id: "ap1", approved: false } },
      { isStreaming: true },
    );
    expect(r.state).toBe("denied");
  });

  it.each([
    ["input-streaming"],
    ["input-available"],
  ])("non-terminal state '%s' + isStreaming:false → 'errored' with turn-ended message", (state) => {
    const r = resolveToolPartState({ state }, { isStreaming: false });
    expect(r.state).toBe("errored");
    const err = (r.result as { error: string }).error;
    expect(err).toMatch(/did not return a result/i);
    // Turn ended before the tool resolved → interruption, not failure.
    expect(r.errorKind).toBe("interrupted");
  });

  it("unknown future state + isStreaming:false → 'errored' (defensive default)", () => {
    const r = resolveToolPartState({ state: "totally-new-state" }, { isStreaming: false });
    expect(r.state).toBe("errored");
  });

  it("missing state + isStreaming:false → 'errored' (defensive default)", () => {
    const r = resolveToolPartState({}, { isStreaming: false });
    expect(r.state).toBe("errored");
  });

  // ── Default opts (no isStreaming provided = undefined = falsy) ───────
  // Matches historical message renders where isStreaming is not passed.

  it("non-terminal state with no opts provided → 'errored' (treats undefined isStreaming as false)", () => {
    const r = resolveToolPartState({ state: "input-available" });
    expect(r.state).toBe("errored");
  });
});
