import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { chatDb } from "@/lib/chat-db";
import { tabRegistry } from "../tab-registry";

/**
 * Regression for the parallel-spaces tab-leak bug.
 *
 * Two chats live in two different Chrome windows (one per Space). The
 * user prompts both chats to navigate. The SW-hosted agent loop's
 * system-prompt awareness block, `listTabs`, and `bindTabByHandle`
 * paths must each scope to the conversation's OWN window — not the
 * focused window — otherwise chat-B can selectTab a tab from chat-A's
 * window and navigate it.
 *
 * The fix routes every window-scoped query through
 * `resolveConversationWindowId(cid)`, whose chain is:
 *
 *   1. owned-tab's window (if the agent already opened tabs)
 *   2. `Conversation.originWindowId` (stamped at create time from the
 *      renderer's `chrome.windows.getCurrent()`)
 *   3. `Space.windowId` for the conversation's space
 *   4. undefined → focused-window fallback (legacy)
 *
 * Each test below pins one rung of this chain.
 */

function makeChromeStub(opts: {
  tabs?: Record<number, { windowId: number; url?: string }>;
  windows?: Set<number>;
  /**
   * Optional shape for `chrome.windows.getAll({ populate: true })`.
   * Maps a windowId to the tabs the window contains. Used by tests that
   * exercise the lazy self-heal in step 3 of the resolver, which searches
   * live windows for a tab whose URL is the space's home-anchor URL when
   * `space.windowId` is null.
   */
  windowTabs?: Record<number, Array<{ url: string }>>;
  spaces?: unknown[];
}) {
  const tabs = opts.tabs ?? {};
  const windows = opts.windows ?? new Set<number>();
  const windowTabs = opts.windowTabs ?? {};
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
      getAll: async (queryInfo?: { populate?: boolean }) => {
        return [...windows].map((id) => ({
          id,
          ...(queryInfo?.populate && { tabs: windowTabs[id] ?? [] }),
        }));
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
  opts: {
    ownedLtids?: string[];
    spaceId?: string | null;
    originWindowId?: number | null;
  } = {},
) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: opts.spaceId ?? null,
    ownedGroupId: null,
    ownedLtids: opts.ownedLtids ?? [],
    createdAt: 0,
    updatedAt: 0,
    ...(opts.originWindowId !== undefined && {
      originWindowId: opts.originWindowId,
    }),
  });
}

function ltidFor(ctid: number): string {
  return tabRegistry.registerExisting(ctid);
}

describe("resolveConversationWindowId — chain (owned → origin → space → undefined)", () => {
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

  it("owned tab's window wins over originWindowId and space window", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        tabs: { 101: { windowId: 3 } },
        windows: new Set([3, 5, 7]),
        spaces: [{ id: "s1", name: "S", windowId: 7, favorites: [] }],
      }),
    );
    await seedConv("c1", {
      ownedLtids: [ltidFor(101)],
      originWindowId: 5,
      spaceId: "s1",
    });
    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    // owned-tab window (3) wins over originWindowId (5) and space window (7).
    expect(await resolveConversationWindowId("c1")).toBe(3);
  });

  it("originWindowId wins when no owned tabs exist", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        windows: new Set([5, 7]),
        spaces: [{ id: "s1", name: "S", windowId: 7, favorites: [] }],
      }),
    );
    await seedConv("c1", { originWindowId: 5, spaceId: "s1" });
    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("c1")).toBe(5);
  });

  it("falls through to space window when originWindowId's window is closed", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        // originWindowId=5 is in conv but NOT in chrome.windows — closed.
        windows: new Set([7]),
        spaces: [{ id: "s1", name: "S", windowId: 7, favorites: [] }],
      }),
    );
    await seedConv("c1", { originWindowId: 5, spaceId: "s1" });
    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("c1")).toBe(7);
  });

  it("returns undefined when nothing resolves (chat without space, origin window closed)", async () => {
    vi.stubGlobal(
      "chrome",
      makeChromeStub({ windows: new Set([99]) }), // 99 isn't any of conv's targets
    );
    await seedConv("c1", { originWindowId: 5, spaceId: null });
    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("c1")).toBeUndefined();
  });

  it("returns undefined for pre-migration rows without originWindowId AND no space", async () => {
    vi.stubGlobal("chrome", makeChromeStub({}));
    await seedConv("c1", {}); // no originWindowId, no spaceId
    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("c1")).toBeUndefined();
  });
});

describe("parallel windows: two conversations stay isolated", () => {
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

  it("two chats in two windows each resolve to their OWN window via originWindowId", async () => {
    // The exact user-reported scenario:
    //   - Space A is in window 100.
    //   - Space B is in window 200.
    //   - User prompts BOTH chats to navigate to news.google.com.
    // The two resolve calls must return 100 and 200 respectively, NOT
    // both fall to whichever window has Chrome's focus.
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        windows: new Set([100, 200]),
        spaces: [
          { id: "sA", name: "A", windowId: 100, favorites: [] },
          { id: "sB", name: "B", windowId: 200, favorites: [] },
        ],
      }),
    );
    await seedConv("conv-A", { originWindowId: 100, spaceId: "sA" });
    await seedConv("conv-B", { originWindowId: 200, spaceId: "sB" });

    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );

    expect(await resolveConversationWindowId("conv-A")).toBe(100);
    expect(await resolveConversationWindowId("conv-B")).toBe(200);
    // Sanity: simultaneous resolution is also stable (no shared mutable
    // state between cids).
    const [a, b] = await Promise.all([
      resolveConversationWindowId("conv-A"),
      resolveConversationWindowId("conv-B"),
    ]);
    expect(a).toBe(100);
    expect(b).toBe(200);
  });
});

describe("step 3 lazy self-heal: space.windowId === null", () => {
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

  /**
   * `chrome.windows.onRemoved` nulls a space's windowId when its bound
   * window closes. The only recovery path — `reconcileSpacesWithWindows` —
   * runs ONLY on extension boot. If the user closes and reopens a space's
   * window between agent runs (very common: SW restart, manual window
   * close, Chrome quit), `Space.windowId` stays null until reconcile runs
   * again, even though the space's anchored home tab (URL containing
   * `?space=<id>`) is alive in some live window.
   *
   * Symptom seen in production: parent chat resolves to `undefined`,
   * `chrome.tabs.create` defaults to Chrome's focused window → new tabs
   * land in a DIFFERENT space's window, leaking the agent's work across
   * spaces.
   *
   * Fix: when step 3 finds `space.windowId === null`, search live windows
   * for a tab whose URL contains the space's anchor (`?space=<spaceId>`).
   * If found, persist the binding back to storage and return that window.
   */

  it("heals when space.windowId is null but the space's anchored home tab is live", async () => {
    // operations space (sX) lost its windowId binding (e.g. window was
    // closed). But window 42 has the space's anchored home tab open.
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        windows: new Set([42]),
        windowTabs: {
          42: [
            {
              url: "chrome-extension://abc/home.html?space=sX",
            },
          ],
        },
        spaces: [{ id: "sX", name: "X", windowId: null, favorites: [] }],
      }),
    );
    await seedConv("conv-X", { spaceId: "sX" });

    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("conv-X")).toBe(42);
  });

  it("persists the healed binding back to storage so subsequent reads are fast", async () => {
    const chromeStub = makeChromeStub({
      windows: new Set([42]),
      windowTabs: {
        42: [{ url: "chrome-extension://abc/home.html?space=sX" }],
      },
      spaces: [{ id: "sX", name: "X", windowId: null, favorites: [] }],
    });
    vi.stubGlobal("chrome", chromeStub);
    await seedConv("conv-X", { spaceId: "sX" });

    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    await resolveConversationWindowId("conv-X");

    const persisted = await chromeStub.storage.local.get("spaces");
    const sX = (persisted.spaces as Array<{ id: string; windowId: number | null }>).find(
      (s) => s.id === "sX",
    );
    expect(sX?.windowId).toBe(42);
  });

  it("returns undefined when space.windowId is null AND no live window has the anchor", async () => {
    // The space was closed entirely — no live window contains its home
    // anchor. Resolver must NOT pick a random window; it must return
    // undefined so the caller's focused-window fallback kicks in.
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        windows: new Set([42, 43]),
        windowTabs: {
          42: [{ url: "https://example.com" }],
          43: [{ url: "chrome-extension://abc/home.html?space=sY" }], // different space
        },
        spaces: [{ id: "sX", name: "X", windowId: null, favorites: [] }],
      }),
    );
    await seedConv("conv-X", { spaceId: "sX" });

    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("conv-X")).toBeUndefined();
  });

  it("picks the correct window when multiple spaces are unbound but only one matches the cid's space", async () => {
    // Both spaces lost their windowIds. The resolver must use the SPACE
    // ANCHOR — not any random space anchor — to find the right window.
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        windows: new Set([100, 200]),
        windowTabs: {
          100: [{ url: "chrome-extension://abc/home.html?space=sA" }],
          200: [{ url: "chrome-extension://abc/home.html?space=sB" }],
        },
        spaces: [
          { id: "sA", name: "A", windowId: null, favorites: [] },
          { id: "sB", name: "B", windowId: null, favorites: [] },
        ],
      }),
    );
    await seedConv("conv-A", { spaceId: "sA" });
    await seedConv("conv-B", { spaceId: "sB" });

    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("conv-A")).toBe(100);
    expect(await resolveConversationWindowId("conv-B")).toBe(200);
  });

  it("ignores a window whose anchor tab points to a different space", async () => {
    // The space's home anchor URL must match the conv's spaceId, not just
    // contain ANY `?space=` parameter. A foreign space's home tab in the
    // focused window must not accidentally claim this conv's resolution.
    vi.stubGlobal(
      "chrome",
      makeChromeStub({
        windows: new Set([42]),
        windowTabs: {
          42: [
            { url: "chrome-extension://abc/home.html?space=sOTHER" },
          ],
        },
        spaces: [{ id: "sX", name: "X", windowId: null, favorites: [] }],
      }),
    );
    await seedConv("conv-X", { spaceId: "sX" });

    const { resolveConversationWindowId } = await import(
      "../conversation-window"
    );
    expect(await resolveConversationWindowId("conv-X")).toBeUndefined();
  });
});
