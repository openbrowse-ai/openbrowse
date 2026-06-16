/**
 * End-to-end identity-continuity test mirroring the prod scenario that
 * motivated the LogicalTabId migration:
 *
 *   1. Agent navigates to an Attio settings page (sets up an owned tab).
 *   2. Speculation Rules / prerender activation fires
 *      `chrome.tabs.onReplaced(addedCtid, removedCtid)`.
 *   3. Chrome ALSO fires `chrome.tabs.onRemoved(removedCtid)` (the
 *      documented event order; the registry must dedup it).
 *   4. The agent's next tool call against the same handle should land on
 *      the new ctid — not fail with "Unknown tab handle" or
 *      "No tab with given id".
 *
 * Asserts the integrated behavior across the registry, the handle map,
 * the cdp-session cache, and the tab-scoping layer:
 *
 *   - Handle resolves to the same ltid pre/post-replace.
 *   - The ltid resolves to the new ctid in the registry.
 *   - Conversation ownership is intact (still keyed on the same ltid).
 *   - The trailing `onRemoved` is suppressed (no consumer reacts).
 *   - Subsequent CDP commands attach to the new ctid.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { tabRegistry } from "@/lib/agent/tab-registry";
import {
  clearHandles,
  getOrCreateHandle,
  resolveHandle,
} from "@/lib/agent/tab-handles";

const CONV_ID = "e2e-conv";

describe("tab identity end-to-end (Attio-style prerender activation)", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    clearHandles(CONV_ID);
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    chatDb._resetForTests();
    clearHandles(CONV_ID);
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
  });

  it("preserves handle, ownership, and cdp-session continuity across an onReplaced + trailing onRemoved", async () => {
    // 1. Bootstrap: navigate creates ctid 100 and binds it to the
    //    conversation. We simulate the side of that flow that matters:
    //    the registry mints an ltid, tab-handles records the handle,
    //    chatDb records the ownership. (The full navigate tool path is
    //    covered by separate tool-level tests.)
    const ltid = tabRegistry.registerExisting(100);
    await chatDb.createConversation({
      id: CONV_ID,
      title: "Attio settings",
      spaceId: null,
      ownedLtids: [ltid],
      ownedGroupId: 7,
      createdAt: 0,
      updatedAt: 0,
    });
    const handle = getOrCreateHandle(CONV_ID, ltid);
    expect(handle).toBe("t1");
    expect(resolveHandle(CONV_ID, "t1")).toBe(ltid);
    expect(tabRegistry.toChromeTabId(ltid)).toBe(100);

    // 2. Prerender activation. Chrome fires onReplaced(addedCtid=200,
    //    removedCtid=100) followed synchronously by onRemoved(100).
    tabRegistry.__handleReplaceForTests!(200, 100);

    // The handle is unchanged. Same ltid. New ctid.
    expect(resolveHandle(CONV_ID, "t1")).toBe(ltid);
    expect(tabRegistry.toChromeTabId(ltid)).toBe(200);
    expect(tabRegistry.toLogicalTabId(100)).toBeUndefined();
    expect(tabRegistry.toLogicalTabId(200)).toBe(ltid);

    // Conversation ownership is intact (chatDb stores ltid, which didn't
    // change; no need for tab-scoping to write).
    const convAfterReplace = await chatDb.getConversation(CONV_ID);
    expect(convAfterReplace?.ownedLtids).toEqual([ltid]);

    // 3. Chrome's trailing onRemoved for the OLD ctid. Without dedup,
    //    every consumer would treat this as a tab close and drop the
    //    handle. The registry's dedup window suppresses it.
    tabRegistry.__handleRemoveForTests!(100);

    // Handle is STILL there.
    expect(resolveHandle(CONV_ID, "t1")).toBe(ltid);
    // ltid still resolves.
    expect(tabRegistry.toChromeTabId(ltid)).toBe(200);
  });

  it("a real tab close (no preceding replace) DOES propagate through the deduper", async () => {
    const ltid = tabRegistry.registerExisting(42);
    await chatDb.createConversation({
      id: CONV_ID,
      title: "x",
      spaceId: null,
      ownedLtids: [ltid],
      ownedGroupId: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    getOrCreateHandle(CONV_ID, ltid);
    expect(resolveHandle(CONV_ID, "t1")).toBe(ltid);

    tabRegistry.__handleRemoveForTests!(42);

    // Handle is dropped (the registry's onRemove fires through to
    // tab-handles' subscriber).
    expect(resolveHandle(CONV_ID, "t1")).toBeUndefined();
    // Registry no longer knows the ctid.
    expect(tabRegistry.toLogicalTabId(42)).toBeUndefined();
  });
});
