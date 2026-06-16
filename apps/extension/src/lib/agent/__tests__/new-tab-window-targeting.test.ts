/**
 * New agent-created tabs should open in the conversation's own window —
 * where the chat and the agent's existing tabs live — not whatever window
 * Chrome happens to have focused. This covers two layers:
 *
 *   1. The `navigate` tool's precedence: a static `session.targetWindowId`
 *      (incognito subagents) wins; otherwise it falls back to the root
 *      agent's async `session.resolveNewTabWindowId()`; otherwise it omits
 *      `windowId` (legacy focused-window behavior).
 *
 *   2. `buildExtensionToolContext(...).session.resolveNewTabWindowId`:
 *      owned-tab window → space window → undefined.
 */

import "fake-indexeddb/auto";
import { tabRegistry } from "../tab-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../chat-db";
import type { ToolContext } from "../driver";
import { buildExtensionToolContext } from "../agent-transport";
import { navigateTool } from "../tools/navigate";

// ─── navigate tool: windowId precedence ─────────────────────────────────

function makeDriver() {
  const created: { url: string; opts: { active?: boolean; windowId?: number } }[] =
    [];
  const driver = {
    createTab: async (
      url: string,
      opts: { active?: boolean; windowId?: number } = {},
    ) => {
      created.push({ url, opts });
      return 999;
    },
    setActiveTab: async () => {},
    waitForLoad: async () => {},
    getActiveTabId: () => null,
    // captureSnapshot calls into the driver; let it fail so navigate takes
    // its caught "snapshot failed" path without us mocking CDP.
    sendCommand: async () => {
      throw new Error("no snapshot in test");
    },
  } as unknown as ToolContext["driver"];
  return { driver, created };
}

describe("navigate — new tab windowId precedence", () => {
  it("uses static session.targetWindowId when set (incognito subagent)", async () => {
    const { driver, created } = makeDriver();
    const resolveNewTabWindowId = vi.fn(async () => 7);
    await navigateTool.execute(
      { url: "https://example.com" },
      {
        driver,
        session: {
          conversationId: "c1",
          targetWindowId: 42,
          resolveNewTabWindowId,
          getOrCreateHandle: () => "t1",
          bindTabsToConversation: async () => {},
        },
      },
    );
    expect(created[0].opts.windowId).toBe(42);
    // Static target short-circuits the async resolver.
    expect(resolveNewTabWindowId).not.toHaveBeenCalled();
  });

  it("falls back to resolveNewTabWindowId for the root agent", async () => {
    const { driver, created } = makeDriver();
    await navigateTool.execute(
      { url: "https://example.com" },
      {
        driver,
        session: {
          conversationId: "c1",
          resolveNewTabWindowId: async () => 5,
          getOrCreateHandle: () => "t1",
          bindTabsToConversation: async () => {},
        },
      },
    );
    expect(created[0].opts.windowId).toBe(5);
  });

  it("omits windowId when neither is available (focused-window fallback)", async () => {
    const { driver, created } = makeDriver();
    await navigateTool.execute(
      { url: "https://example.com" },
      {
        driver,
        session: {
          conversationId: "c1",
          resolveNewTabWindowId: async () => undefined,
          getOrCreateHandle: () => "t1",
          bindTabsToConversation: async () => {},
        },
      },
    );
    expect("windowId" in created[0].opts).toBe(false);
  });

  it("swallows resolver rejection and still creates the tab", async () => {
    const { driver, created } = makeDriver();
    await navigateTool.execute(
      { url: "https://example.com" },
      {
        driver,
        session: {
          conversationId: "c1",
          resolveNewTabWindowId: async () => {
            throw new Error("transient lookup failure");
          },
          getOrCreateHandle: () => "t1",
          bindTabsToConversation: async () => {},
        },
      },
    );
    expect(created).toHaveLength(1);
    expect("windowId" in created[0].opts).toBe(false);
  });
});

// ─── buildExtensionToolContext.resolveNewTabWindowId ─────────────────────

function makeChromeStub(opts: {
  tabs?: Record<number, { windowId: number }>;
  windows?: Set<number>;
  spaces?: unknown[];
}) {
  const tabs = opts.tabs ?? {};
  const windows = opts.windows ?? new Set<number>();
  let store: Record<string, unknown> = {
    spaces: opts.spaces ?? [],
  };
  return {
    runtime: { id: "test", sendMessage: vi.fn(async () => undefined) },
    tabs: {
      get: async (id: number) => {
        const t = tabs[id];
        if (!t) throw new Error(`no tab ${id}`);
        return { id, ...t };
      },
    },
    windows: {
      get: async (id: number) => {
        if (!windows.has(id)) throw new Error(`no window ${id}`);
        return { id };
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => {
          store = { ...store, ...obj };
        },
      },
    },
  };
}

async function seedConv(
  id: string,
  opts: { ownedLtids?: string[]; spaceId?: string | null } = {},
) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: opts.spaceId ?? null,
    ownedGroupId: null,
    ownedLtids: opts.ownedLtids ?? [],
    createdAt: 0,
    updatedAt: 0,
  });
}

/**
 * Mint an ltid via the registry for a fake ctid; used by tests below
 * that drive `resolveNewTabWindowId`, which now resolves `ownedLtids`
 * through the registry to live ctids before consulting `chrome.tabs.get`.
 */
function ltidFor(ctid: number): string {
  return tabRegistry.registerExisting(ctid);
}

describe("buildExtensionToolContext — resolveNewTabWindowId", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
  });

  it("returns the window of the first live owned tab", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({ tabs: { 101: { windowId: 3 }, 102: { windowId: 9 } } }),
    );
    await seedConv("c1", { ownedLtids: [ltidFor(101), ltidFor(102)] });
    const ctx = buildExtensionToolContext("c1");
    expect(await ctx.session?.resolveNewTabWindowId?.()).toBe(3);
  });

  it("skips dead owned tabs and uses the first live one", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({ tabs: { 102: { windowId: 9 } } }), // 101 is gone
    );
    // Mint ltids for BOTH ctids in the registry — the registry maps
    // ltid → ctid; whether the ctid is alive in chrome is checked via
    // the chrome.tabs.get probe.
    await seedConv("c1", { ownedLtids: [ltidFor(101), ltidFor(102)] });
    const ctx = buildExtensionToolContext("c1");
    expect(await ctx.session?.resolveNewTabWindowId?.()).toBe(9);
  });

  it("falls back to the space window when no owned tabs are live", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        tabs: {},
        windows: new Set([8]),
        spaces: [{ id: "s1", name: "S", windowId: 8, favorites: [] }],
      }),
    );
    await seedConv("c1", { ownedLtids: [], spaceId: "s1" });
    const ctx = buildExtensionToolContext("c1");
    expect(await ctx.session?.resolveNewTabWindowId?.()).toBe(8);
  });

  it("returns undefined when the space window no longer exists", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        tabs: {},
        windows: new Set<number>(), // window 8 was closed
        spaces: [{ id: "s1", name: "S", windowId: 8, favorites: [] }],
      }),
    );
    await seedConv("c1", { ownedLtids: [], spaceId: "s1" });
    const ctx = buildExtensionToolContext("c1");
    expect(await ctx.session?.resolveNewTabWindowId?.()).toBeUndefined();
  });

  it("returns undefined when there are no owned tabs and no space", async () => {
    vi.stubGlobal("chrome", makeChromeStub({ tabs: {} }));
    await seedConv("c1", { ownedLtids: [], spaceId: null });
    const ctx = buildExtensionToolContext("c1");
    expect(await ctx.session?.resolveNewTabWindowId?.()).toBeUndefined();
  });

  it("returns undefined for a null-pinned context", async () => {
    vi.stubGlobal("chrome", makeChromeStub({ tabs: {} }));
    const ctx = buildExtensionToolContext(null);
    expect(await ctx.session?.resolveNewTabWindowId?.()).toBeUndefined();
  });
});
