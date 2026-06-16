/**
 * Tests for `waitForTabLoad`'s ltid-aware behavior: it resolves when the
 * `chrome.tabs.id` corresponding to the passed ltid fires a `complete`
 * status update, AND it follows `onReplaced` mid-wait so a Speculation
 * Rules / prerender activation that swaps the ctid doesn't time out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabRegistry } from "../tab-registry";
import { waitForTabLoad } from "../active-tab";

type UpdateListener = (
  tabId: number,
  changeInfo: { status?: string },
) => void;

describe("waitForTabLoad: ltid-aware", () => {
  let updateListeners: UpdateListener[];

  beforeEach(() => {
    tabRegistry.__resetForTests!();
    updateListeners = [];
    vi.stubGlobal("chrome", {
      tabs: {
        onUpdated: {
          addListener: (fn: UpdateListener) => {
            updateListeners.push(fn);
          },
          removeListener: (fn: UpdateListener) => {
            const i = updateListeners.indexOf(fn);
            if (i >= 0) updateListeners.splice(i, 1);
          },
        },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tabRegistry.__resetForTests!();
    tabRegistry.__clearListenersForTests!();
  });

  function fireUpdate(ctid: number, status: string) {
    for (const fn of [...updateListeners]) {
      fn(ctid, { status });
    }
  }

  it("resolves when the underlying ctid fires complete", async () => {
    const ltid = tabRegistry.registerExisting(100);

    // Use real-but-short timers; the resolver waits 500ms after `complete`
    // before resolving. We just need a longer timeout.
    const p = waitForTabLoad(ltid, 5000);
    fireUpdate(100, "complete");
    await expect(p).resolves.toBeUndefined();
  });

  it("ignores updates for unrelated ctids", async () => {
    const ltid = tabRegistry.registerExisting(100);
    const p = waitForTabLoad(ltid, 1500);
    fireUpdate(999, "complete"); // wrong ctid
    fireUpdate(100, "complete");
    await expect(p).resolves.toBeUndefined();
  });

  it("follows onReplaced: complete on NEW ctid still resolves", async () => {
    const ltid = tabRegistry.registerExisting(100);

    const p = waitForTabLoad(ltid, 5000);

    // Mid-wait, fire onReplaced to swap ctid 100 → 200.
    tabRegistry.__handleReplaceForTests!(200, 100);

    // The complete event lands on 200, the new ctid. Without the ltid-aware
    // listener swap this would have been ignored.
    fireUpdate(200, "complete");

    await expect(p).resolves.toBeUndefined();
  });

  it("ignores complete on the OLD ctid after onReplaced", async () => {
    const ltid = tabRegistry.registerExisting(100);

    const p = waitForTabLoad(ltid, 1200);
    tabRegistry.__handleReplaceForTests!(200, 100);

    // A spurious late event for the OLD ctid should NOT resolve.
    fireUpdate(100, "complete");
    // Then real completion on the new ctid.
    fireUpdate(200, "complete");

    await expect(p).resolves.toBeUndefined();
  });

  it("times out if no complete event fires", async () => {
    const ltid = tabRegistry.registerExisting(100);
    await expect(waitForTabLoad(ltid, 50)).rejects.toThrow(/timed out/i);
  });

  it("removes its listeners on resolve", async () => {
    const ltid = tabRegistry.registerExisting(100);
    expect(updateListeners.length).toBe(0);
    const p = waitForTabLoad(ltid, 5000);
    expect(updateListeners.length).toBe(1);
    fireUpdate(100, "complete");
    await p;
    expect(updateListeners.length).toBe(0);
  });
});
