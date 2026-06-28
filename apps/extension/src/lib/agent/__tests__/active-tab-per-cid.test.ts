import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabRegistry } from "../tab-registry";

/**
 * Per-cid `targetLtid` slot regression coverage.
 *
 * Pre-refactor: `active-tab.ts` held a single module-scope
 * `targetLtid`. Under SW-host the same module instance serves every
 * concurrent agent run, so two chats setting/reading their target
 * tabs would clobber each other's `targetLtid`. Now each cid keys
 * into its own slot in a Map; the legacy single-slot behavior is
 * preserved as a fallback bucket for callers that don't provide a
 * cid (tests, the bench harness).
 */

function makeChromeStub() {
  const tabs = new Map<number, chrome.tabs.Tab>();
  return {
    tabs,
    chrome: {
      tabs: {
        get: vi.fn(async (id: number) => {
          const t = tabs.get(id);
          if (!t) throw new Error(`no tab ${id}`);
          return t;
        }),
        query: vi.fn(async (_q: chrome.tabs.QueryInfo) => {
          return Array.from(tabs.values()).filter((t) => t.active);
        }),
      },
      windows: {
        get: vi.fn(async (id: number) => ({ id })),
      },
      runtime: { id: "test" },
    } as unknown as typeof chrome,
  };
}

describe("active-tab.ts: per-cid target slot", () => {
  beforeEach(() => {
    vi.resetModules();
    tabRegistry.__resetForTests!();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("setTargetTabId for cid-A and cid-B are independent", async () => {
    const { chrome: fake } = makeChromeStub();
    vi.stubGlobal("chrome", fake);

    const mod = await import("../active-tab");
    mod.__resetActiveTabForTests();

    mod.setTargetTabId(101, "conv-A");
    mod.setTargetTabId(202, "conv-B");

    // Each cid sees its own ctid via the registry resolution path.
    expect(mod.getTargetTabId("conv-A")).toBe(101);
    expect(mod.getTargetTabId("conv-B")).toBe(202);

    // Clearing conv-A doesn't touch conv-B.
    mod.setTargetTabId(null, "conv-A");
    expect(mod.getTargetTabId("conv-A")).toBeNull();
    expect(mod.getTargetTabId("conv-B")).toBe(202);
  });

  it("legacy no-cid setters use the fallback slot, independent of cid maps", async () => {
    const { chrome: fake } = makeChromeStub();
    vi.stubGlobal("chrome", fake);

    const mod = await import("../active-tab");
    mod.__resetActiveTabForTests();
    // No registered cid resolver in this test (we haven't imported
    // agent-transport), so undefined cid falls to the legacy slot.
    mod.setTargetTabId(101);

    expect(mod.getTargetTabId()).toBe(101);
    // The cid-A slot is empty — the legacy setter doesn't leak.
    expect(mod.getTargetTabId("conv-A")).toBeNull();
  });

  it("getActiveUserTab bootstraps under cid-A's window and pins under cid-A only", async () => {
    const { chrome: fake, tabs } = makeChromeStub();
    // Two windows, each with one active tab.
    tabs.set(901, {
      id: 901,
      windowId: 1,
      active: true,
      url: "https://a.example",
    } as chrome.tabs.Tab);
    tabs.set(902, {
      id: 902,
      windowId: 2,
      active: true,
      url: "https://b.example",
    } as chrome.tabs.Tab);
    // Make query window-aware.
    fake.tabs.query = vi.fn(async (q: chrome.tabs.QueryInfo) => {
      return Array.from(tabs.values()).filter(
        (t) =>
          (q.active === undefined || t.active === q.active) &&
          (q.windowId === undefined || t.windowId === q.windowId),
      );
    });
    vi.stubGlobal("chrome", fake);

    const mod = await import("../active-tab");
    mod.__resetActiveTabForTests();

    // Bootstrap cid-A scoped to window 1.
    const tabA = await mod.getActiveUserTab({
      conversationId: "conv-A",
      windowId: 1,
    });
    expect(tabA.id).toBe(901);

    // cid-B sees no pinned target yet — bootstraps independently to window 2.
    const tabB = await mod.getActiveUserTab({
      conversationId: "conv-B",
      windowId: 2,
    });
    expect(tabB.id).toBe(902);

    // Pinned-target reads stay per-cid.
    expect(mod.getTargetTabId("conv-A")).toBe(901);
    expect(mod.getTargetTabId("conv-B")).toBe(902);
  });

  it("getActiveUserTab without explicit windowId scopes to currentWindow (legacy)", async () => {
    const { chrome: fake, tabs } = makeChromeStub();
    tabs.set(900, {
      id: 900,
      windowId: 1,
      active: true,
      url: "https://x.example",
    } as chrome.tabs.Tab);
    fake.tabs.query = vi.fn(async (q: chrome.tabs.QueryInfo) => {
      // Tests with no windowId must use currentWindow:true to match legacy
      // semantics.
      expect(q.currentWindow).toBe(true);
      expect(q.windowId).toBeUndefined();
      return Array.from(tabs.values()).filter((t) => t.active);
    });
    vi.stubGlobal("chrome", fake);

    const mod = await import("../active-tab");
    mod.__resetActiveTabForTests();

    // No conversationId AND no windowId → legacy currentWindow:true path.
    const tab = await mod.getActiveUserTab({});
    expect(tab.id).toBe(900);
  });
});
