/**
 * Unit tests for `tab-registry`. Drives the registry via its `__*ForTests`
 * seams to avoid coupling tests to vitest's chrome-mock listener wiring
 * (which would make order-of-import sensitive).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabRegistry } from "../tab-registry";

describe("tab-registry", () => {
  beforeEach(() => {
    tabRegistry.__resetForTests!();
    tabRegistry.__clearListenersForTests!();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registerExisting", () => {
    it("mints a fresh ltid for a new ctid", () => {
      const ltid = tabRegistry.registerExisting(100);
      expect(typeof ltid).toBe("string");
      expect(ltid.length).toBeGreaterThan(0);
      expect(tabRegistry.toChromeTabId(ltid)).toBe(100);
      expect(tabRegistry.toLogicalTabId(100)).toBe(ltid);
    });

    it("is idempotent for the same ctid", () => {
      const ltid1 = tabRegistry.registerExisting(100);
      const ltid2 = tabRegistry.registerExisting(100);
      expect(ltid1).toBe(ltid2);
    });
  });

  describe("onReplaced", () => {
    it("re-keys the ltid to the new ctid", () => {
      const ltid = tabRegistry.registerExisting(100);
      tabRegistry.__handleReplaceForTests!(200, 100);
      expect(tabRegistry.toChromeTabId(ltid)).toBe(200);
      expect(tabRegistry.toLogicalTabId(200)).toBe(ltid);
      expect(tabRegistry.toLogicalTabId(100)).toBeUndefined();
    });

    it("fires onReplace subscribers", () => {
      const ltid = tabRegistry.registerExisting(100);
      const seen: unknown[] = [];
      tabRegistry.onReplace((ev) => seen.push(ev));
      tabRegistry.__handleReplaceForTests!(200, 100);
      expect(seen).toEqual([
        expect.objectContaining({ ltid, oldCtid: 100, newCtid: 200 }),
      ]);
    });

    it("mints a fresh ltid when the removed ctid was never tracked", () => {
      // No prior registration of 100.
      const seen: unknown[] = [];
      tabRegistry.onReplace((ev) => seen.push(ev));
      tabRegistry.__handleReplaceForTests!(200, 100);
      expect(seen).toEqual([]); // no event for untracked replace
      // But 200 IS now registered so future tools can find it.
      const ltid = tabRegistry.toLogicalTabId(200);
      expect(ltid).toBeTruthy();
    });

    it("logs a console.warn with url + ltid", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      tabRegistry.registerExisting(100);
      tabRegistry.__handleReplaceForTests!(200, 100);
      // chrome.tabs.get in the test stub rejects; the catch path still
      // logs (with url=undefined). Allow the microtask to drain.
      await Promise.resolve();
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith(
        "[tab-registry] onReplaced",
        expect.objectContaining({ ltid: expect.any(String), oldCtid: 100, newCtid: 200 }),
      );
    });
  });

  describe("onRemoved dedup", () => {
    it("suppresses onRemoved within the dedup window after onReplaced", () => {
      tabRegistry.registerExisting(100);
      const removed: unknown[] = [];
      tabRegistry.onRemove((ev) => removed.push(ev));
      tabRegistry.__handleReplaceForTests!(200, 100);
      tabRegistry.__handleRemoveForTests!(100); // trailing remove
      expect(removed).toEqual([]); // suppressed
    });

    it("fires onRemove for a non-replaced ctid", () => {
      const ltid = tabRegistry.registerExisting(100);
      const removed: unknown[] = [];
      tabRegistry.onRemove((ev) => removed.push(ev));
      tabRegistry.__handleRemoveForTests!(100);
      expect(removed).toEqual([{ ltid, ctid: 100 }]);
      expect(tabRegistry.toLogicalTabId(100)).toBeUndefined();
    });

    it("fires onRemove after the dedup window expires", () => {
      const initialNow = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(initialNow);
      tabRegistry.registerExisting(100);
      tabRegistry.__handleReplaceForTests!(200, 100);
      // Advance past the 5s dedup window.
      dateSpy.mockReturnValue(initialNow + 6_000);
      // A late onRemoved for the OLD ctid (100). It's no longer in the
      // ltid map (the replace re-keyed to 200), so emit semantics: nothing
      // happens. We're really asserting "no crash" + dedup didn't suppress.
      const removed: unknown[] = [];
      tabRegistry.onRemove((ev) => removed.push(ev));
      tabRegistry.__handleRemoveForTests!(100);
      expect(removed).toEqual([]); // 100 isn't tracked anymore
      // Simulate also a real removal of the new ctid 200 — should fire.
      tabRegistry.__handleRemoveForTests!(200);
      expect(removed.length).toBe(1);
    });

    it("is a no-op for never-registered ctids", () => {
      const removed: unknown[] = [];
      tabRegistry.onRemove((ev) => removed.push(ev));
      expect(() => tabRegistry.__handleRemoveForTests!(999)).not.toThrow();
      expect(removed).toEqual([]);
    });
  });

  describe("subscriber semantics", () => {
    it("fires multiple subscribers in registration order on replace", () => {
      tabRegistry.registerExisting(100);
      const order: string[] = [];
      tabRegistry.onReplace(() => order.push("a"));
      tabRegistry.onReplace(() => order.push("b"));
      tabRegistry.onReplace(() => order.push("c"));
      tabRegistry.__handleReplaceForTests!(200, 100);
      expect(order).toEqual(["a", "b", "c"]);
    });

    it("a throwing subscriber doesn't break later subscribers", () => {
      tabRegistry.registerExisting(100);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const order: string[] = [];
      tabRegistry.onReplace(() => {
        throw new Error("boom");
      });
      tabRegistry.onReplace(() => order.push("survived"));
      tabRegistry.__handleReplaceForTests!(200, 100);
      expect(order).toEqual(["survived"]);
      expect(warn).toHaveBeenCalledWith(
        "[tab-registry] onReplace subscriber threw",
        expect.any(Error),
      );
    });

    it("returns an unsubscribe function from onReplace", () => {
      tabRegistry.registerExisting(100);
      const seen: unknown[] = [];
      const off = tabRegistry.onReplace((ev) => seen.push(ev));
      off();
      tabRegistry.__handleReplaceForTests!(200, 100);
      expect(seen).toEqual([]);
    });
  });

  describe("unregister", () => {
    it("forgets both directions and is idempotent", () => {
      const ltid = tabRegistry.registerExisting(100);
      tabRegistry.unregister(ltid);
      expect(tabRegistry.toChromeTabId(ltid)).toBeUndefined();
      expect(tabRegistry.toLogicalTabId(100)).toBeUndefined();
      expect(() => tabRegistry.unregister(ltid)).not.toThrow();
    });
  });
});
