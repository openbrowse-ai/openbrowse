/**
 * Cross-extension iframe bail-early in `cdp-session`.
 *
 * The shared CDP session manager classifies errors into three buckets:
 *
 *   - Detach errors (e.g. "Detached while handling command", "No tab with
 *     given id"): drop the cached Session and re-attach once.
 *   - Cross-extension frame errors (e.g. "Cannot access a chrome-extension://
 *     URL of different extension"): the session is HEALTHY — only this
 *     specific call walked into a hostile iframe. Bubble unchanged; do NOT
 *     drop the session and do NOT retry, so the caller (snapshot-capture)
 *     can pick the per-frame fallback path.
 *   - Anything else: pass through.
 *
 * Misclassifying a cross-ext error as a detach would burn the retry budget
 * and thrash the attach state for nothing — the second whole-tree call
 * would hit the same iframe and fail identically. These tests pin down the
 * bail-early behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CROSS_EXT_ERROR =
  "Cannot access a chrome-extension:// URL of different extension";

describe("cdp-session: cross-extension frame error", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT drop the session or retry on cross-extension error during sendCommand", async () => {
    const attachCalls: number[] = [];
    let sendCallCount = 0;
    vi.stubGlobal("chrome", {
      tabs: {
        onRemoved: { addListener: () => {} },
        onReplaced: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
        onCreated: { addListener: () => {} },
        get: () => Promise.resolve({ id: 1, url: "" }),
      },
      debugger: {
        onDetach: { addListener: () => {} },
        onEvent: { addListener: () => {} },
        attach: vi.fn((target: { tabId: number }) => {
          attachCalls.push(target.tabId);
          return Promise.resolve();
        }),
        detach: vi.fn(() => Promise.resolve()),
        sendCommand: vi.fn((_target, method: string) => {
          sendCallCount++;
          // The cross-ext error fires from the AX command, not from the
          // domain.enable bookkeeping call. Reject only the AX one so the
          // test pins the behavior of the post-enable catch branch.
          if (method === "Accessibility.getFullAXTree") {
            return Promise.reject(new Error(CROSS_EXT_ERROR));
          }
          return Promise.resolve({});
        }),
      },
    });

    const { sendCommand } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    // First a benign call to seed the cached session for ctid 7.
    await sendCommand(7, "Page.bringToFront");
    expect(attachCalls).toEqual([7]);

    const attachesBefore = attachCalls.length;
    const sendsBefore = sendCallCount;

    // Now the AX call rejects with the cross-ext error.
    let caught: Error | null = null;
    try {
      await sendCommand(7, "Accessibility.getFullAXTree");
    } catch (e) {
      caught = e as Error;
    }

    // The error bubbles UNCHANGED.
    expect(caught).not.toBeNull();
    expect(caught?.message).toBe(CROSS_EXT_ERROR);

    // No retry — sendCommand was called exactly once for the AX method, on
    // top of any preceding domain.enable call. With NO_ENABLE_DOMAINS
    // listing "Runtime"/"Page"/etc., Accessibility goes through .enable
    // first then the AX call → 2 sends total for this round, NOT 4 (which
    // would be 2 attempts × 2 sends).
    const sendsThisRound = sendCallCount - sendsBefore;
    expect(sendsThisRound).toBeLessThanOrEqual(2);

    // No fresh attach (no session teardown).
    expect(attachCalls.length).toBe(attachesBefore);

    // Subsequent benign call should reuse the existing session — i.e. NO
    // new attach. Proves the cross-ext error didn't tear down the cache.
    await sendCommand(7, "Page.bringToFront");
    expect(attachCalls.length).toBe(attachesBefore);
  });

  it("does NOT drop the session when the error fires from a domain.enable call", async () => {
    // Some sites trigger the cross-ext rejection on the bookkeeping
    // `<Domain>.enable` call rather than on the actual AX command. The
    // bail-early branch must cover both catch sites.
    const attachCalls: number[] = [];
    vi.stubGlobal("chrome", {
      tabs: {
        onRemoved: { addListener: () => {} },
        onReplaced: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
        onCreated: { addListener: () => {} },
        get: () => Promise.resolve({ id: 1, url: "" }),
      },
      debugger: {
        onDetach: { addListener: () => {} },
        onEvent: { addListener: () => {} },
        attach: vi.fn((target: { tabId: number }) => {
          attachCalls.push(target.tabId);
          return Promise.resolve();
        }),
        detach: vi.fn(() => Promise.resolve()),
        sendCommand: vi.fn((_target, method: string) => {
          if (method === "Accessibility.enable") {
            return Promise.reject(new Error(CROSS_EXT_ERROR));
          }
          return Promise.resolve({});
        }),
      },
    });

    const { sendCommand } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    const attachesBefore = attachCalls.length;
    let caught: Error | null = null;
    try {
      await sendCommand(11, "Accessibility.getFullAXTree");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe(CROSS_EXT_ERROR);
    // First attach happened (this is the seeding attach for ctid 11). We
    // care that no SECOND attach was forced by retry teardown.
    expect(attachCalls.filter((id) => id === 11).length).toBe(1);
    // attachesBefore is 0 here; the assertion above is the meaningful one.
    void attachesBefore;
  });
});
