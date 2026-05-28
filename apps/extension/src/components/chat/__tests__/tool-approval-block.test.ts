import { describe, expect, it, vi } from "vitest";
import { handleAlwaysAllow } from "../ToolApprovalBlock";

/**
 * Tests for the "Always allow on <site>" click ordering.
 *
 * The bug: previous implementation fired `onAlwaysAllow` (async — writes
 * to chrome.storage.local) and `onApprove` synchronously, so the agent
 * resumed before the storage write landed. The next tool call's
 * `needsApproval` callback then read the pre-write allowlist and
 * prompted the user again — observed reliably on home.html where the
 * agent issues back-to-back executeOnPage calls.
 *
 * The fix: handleAlwaysAllow awaits the persist before invoking
 * onApprove, even when the persist throws (rare; storage quota
 * exhausted). The user's intent to approve THIS call is independent of
 * the cross-call grant.
 */

describe("handleAlwaysAllow", () => {
  it("awaits the persist before calling onApprove", async () => {
    const events: string[] = [];

    let resolvePersist!: () => void;
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });

    const onAlwaysAllow = vi.fn(async () => {
      events.push("persist:start");
      await persistPromise;
      events.push("persist:end");
    });
    const onApprove = vi.fn(() => {
      events.push("approve");
    });

    const handlerPromise = handleAlwaysAllow({
      toolName: "executeOnPage",
      origin: "https://bookface.ycombinator.com",
      approvalId: "ap-1",
      onAlwaysAllow,
      onApprove,
    });

    // Synchronously after kicking the handler off, persist has started
    // but onApprove hasn't been called yet. This is the load-bearing
    // ordering — the previous implementation called onApprove here.
    expect(events).toEqual(["persist:start"]);
    expect(onApprove).not.toHaveBeenCalled();

    resolvePersist();
    await handlerPromise;

    expect(events).toEqual(["persist:start", "persist:end", "approve"]);
    expect(onApprove).toHaveBeenCalledExactlyOnceWith("ap-1");
    expect(onAlwaysAllow).toHaveBeenCalledExactlyOnceWith(
      "executeOnPage",
      "https://bookface.ycombinator.com",
    );
  });

  it("still approves when the persist throws (storage quota etc.)", async () => {
    const onAlwaysAllow = vi.fn(async () => {
      throw new Error("QUOTA_BYTES exceeded");
    });
    const onApprove = vi.fn();
    const warn = vi.fn();

    await handleAlwaysAllow({
      toolName: "executeOnPage",
      origin: "https://bookface.ycombinator.com",
      approvalId: "ap-2",
      onAlwaysAllow,
      onApprove,
      warn,
    });

    expect(onApprove).toHaveBeenCalledExactlyOnceWith("ap-2");
    // Persist failure is logged but not re-thrown — the agent's task
    // shouldn't fail just because the cross-call grant couldn't be
    // recorded.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/failed to persist/i);
  });

  it("supports synchronous onAlwaysAllow implementations", async () => {
    // The prop type allows `void | Promise<void>` for callers who
    // want to skip persistence (e.g. tests or in-memory grants).
    const onAlwaysAllow = vi.fn();
    const onApprove = vi.fn();

    await handleAlwaysAllow({
      toolName: "executeOnPage",
      origin: "https://example.com",
      approvalId: "ap-3",
      onAlwaysAllow,
      onApprove,
    });

    expect(onAlwaysAllow).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledExactlyOnceWith("ap-3");
  });
});
