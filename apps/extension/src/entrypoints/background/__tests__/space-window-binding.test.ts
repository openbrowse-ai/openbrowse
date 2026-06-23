import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Space } from "@/lib/types";

/**
 * Regression tests for the "windows lose their space after an extension
 * update" bug. On update Chrome destroys every pinned `home.html?space=<id>`
 * tab (so the anchors are gone) but the windows + their ids survive and
 * `Space.windowId` is still valid. Reconcile must NOT discard those still-live
 * bindings, the post-update restore must recreate the anchored home tabs, and
 * a manually reopened home tab must carry its `?space=` anchor.
 */

const HOME_BASE = "chrome-extension://test/home.html";

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  pinned: boolean;
  index: number;
  active: boolean;
}

let store: Record<string, unknown>;
let tabs: FakeTab[];
let nextTabId: number;

function installChromeStub() {
  store = {};
  tabs = [];
  nextTabId = 1;

  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (p: string) =>
        `chrome-extension://test/${p.replace(/^\//, "")}`,
    },
    windows: {
      getAll: (_opts?: unknown) => {
        const ids = [...new Set(tabs.map((t) => t.windowId))];
        return Promise.resolve(
          ids.map((id) => ({
            id,
            type: "normal",
            tabs: tabs.filter((t) => t.windowId === id),
          })),
        );
      },
      update: (id: number) => Promise.resolve({ id }),
      create: () => Promise.resolve({ id: 999, tabs: [] }),
    },
    tabs: {
      query: (q: { windowId?: number; pinned?: boolean }) => {
        let res = tabs.slice();
        if (q.windowId != null) res = res.filter((t) => t.windowId === q.windowId);
        if (q.pinned != null) res = res.filter((t) => t.pinned === q.pinned);
        return Promise.resolve(res.map((t) => ({ ...t })));
      },
      get: (id: number) => {
        const t = tabs.find((x) => x.id === id);
        return t ? Promise.resolve({ ...t }) : Promise.reject(new Error("no tab"));
      },
      create: (props: {
        windowId: number;
        url: string;
        pinned?: boolean;
        index?: number;
        active?: boolean;
      }) => {
        const tab: FakeTab = {
          id: nextTabId++,
          windowId: props.windowId,
          url: props.url,
          pinned: props.pinned ?? false,
          index: props.index ?? tabs.filter((t) => t.windowId === props.windowId).length,
          active: props.active ?? false,
        };
        tabs.push(tab);
        return Promise.resolve({ ...tab });
      },
      update: (id: number, props: Partial<FakeTab>) => {
        const tab = tabs.find((t) => t.id === id);
        if (tab) Object.assign(tab, props);
        return Promise.resolve(tab ? { ...tab } : undefined);
      },
      move: (id: number, props: { index: number }) => {
        const tab = tabs.find((t) => t.id === id);
        if (tab) tab.index = props.index;
        return Promise.resolve(tab ? { ...tab } : undefined);
      },
    },
    storage: {
      local: {
        get: (key?: string | string[]) => {
          if (typeof key === "string")
            return Promise.resolve({ [key]: store[key] });
          return Promise.resolve({ ...store });
        },
        set: (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
          return Promise.resolve();
        },
      },
    },
  });
}

function makeSpace(over: Partial<Space> & { id: string }): Space {
  return {
    name: over.id,
    icon: null,
    windowId: null,
    position: 1,
    favorites: [],
    pinnedTabs: [],
    colors: null,
    colorMode: null,
    instructions: null,
    description: null,
    updatedAt: 0,
    ...over,
  };
}

function seedSpaces(spaces: Space[]) {
  store["spaces"] = spaces;
}

function addTab(t: Partial<FakeTab> & { windowId: number; url: string }) {
  tabs.push({
    id: nextTabId++,
    pinned: false,
    index: tabs.filter((x) => x.windowId === t.windowId).length,
    active: false,
    ...t,
  } as FakeTab);
}

describe("reconcileSpacesWithWindows — binding preservation", () => {
  beforeEach(() => installChromeStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("preserves windowId for a live window whose anchor tab was destroyed (post-update)", async () => {
    // Three windows bound to three spaces. No anchor tabs, no pinned tabs —
    // exactly the post-update state (Chrome destroyed the home tabs).
    seedSpaces([
      makeSpace({ id: "s1", windowId: 11, position: 1 }),
      makeSpace({ id: "s2", windowId: 22, position: 2 }),
      makeSpace({ id: "s3", windowId: 33, position: 3 }),
    ]);
    // Each window still exists (has a non-home tab), but no anchored home tab.
    addTab({ windowId: 11, url: "https://a.test/" });
    addTab({ windowId: 22, url: "https://b.test/" });
    addTab({ windowId: 33, url: "https://c.test/" });

    const { reconcileSpacesWithWindows } = await import("../spaces");
    await reconcileSpacesWithWindows();

    const spaces = store["spaces"] as Space[];
    expect(spaces.find((s) => s.id === "s1")!.windowId).toBe(11);
    expect(spaces.find((s) => s.id === "s2")!.windowId).toBe(22);
    expect(spaces.find((s) => s.id === "s3")!.windowId).toBe(33);
  });

  it("clears windowId for a space whose window is no longer live (browser restart)", async () => {
    seedSpaces([
      makeSpace({ id: "s1", windowId: 11, position: 1 }),
      makeSpace({ id: "s2", windowId: 99, position: 2 }), // 99 not live
    ]);
    // Only window 11 is live.
    addTab({ windowId: 11, url: "https://a.test/" });

    const { reconcileSpacesWithWindows } = await import("../spaces");
    await reconcileSpacesWithWindows();

    const spaces = store["spaces"] as Space[];
    expect(spaces.find((s) => s.id === "s1")!.windowId).toBe(11);
    expect(spaces.find((s) => s.id === "s2")!.windowId).toBeNull();
  });

  it("rebinds via the ?space= anchor (Pass 1) when window ids changed", async () => {
    // Browser restart: stored windowId is stale (7), but the restored window
    // (id 11) carries the anchor tab.
    seedSpaces([makeSpace({ id: "s1", windowId: 7, position: 1 })]);
    addTab({
      windowId: 11,
      url: `${HOME_BASE}?space=s1`,
      pinned: true,
      index: 0,
    });

    const { reconcileSpacesWithWindows } = await import("../spaces");
    await reconcileSpacesWithWindows();

    const spaces = store["spaces"] as Space[];
    expect(spaces.find((s) => s.id === "s1")!.windowId).toBe(11);
  });
});

describe("restoreHomeTabsAfterUpdate", () => {
  beforeEach(() => installChromeStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("recreates an anchored pinned home tab for each bound live window, untouched bindings", async () => {
    seedSpaces([
      makeSpace({ id: "s1", windowId: 11, position: 1 }),
      makeSpace({ id: "s2", windowId: 22, position: 2 }),
    ]);
    // Live windows, home tabs destroyed (only ordinary tabs remain).
    addTab({ windowId: 11, url: "https://a.test/" });
    addTab({ windowId: 22, url: "https://b.test/" });

    const { restoreHomeTabsAfterUpdate } = await import("../spaces");
    await restoreHomeTabsAfterUpdate();

    const home11 = tabs.find(
      (t) => t.windowId === 11 && t.url === `${HOME_BASE}?space=s1`,
    );
    const home22 = tabs.find(
      (t) => t.windowId === 22 && t.url === `${HOME_BASE}?space=s2`,
    );
    expect(home11).toBeDefined();
    expect(home11!.pinned).toBe(true);
    expect(home22).toBeDefined();
    expect(home22!.pinned).toBe(true);

    // Bindings preserved.
    const spaces = store["spaces"] as Space[];
    expect(spaces.find((s) => s.id === "s1")!.windowId).toBe(11);
    expect(spaces.find((s) => s.id === "s2")!.windowId).toBe(22);
  });

  it("re-stamps the anchor on an existing un-anchored home tab", async () => {
    seedSpaces([makeSpace({ id: "s1", windowId: 11, position: 1 })]);
    addTab({ windowId: 11, url: HOME_BASE, pinned: true, index: 0 });

    const { restoreHomeTabsAfterUpdate } = await import("../spaces");
    await restoreHomeTabsAfterUpdate();

    const home = tabs.find((t) => t.windowId === 11);
    expect(home!.url).toBe(`${HOME_BASE}?space=s1`);
    expect(home!.pinned).toBe(true);
  });

  it("does not create a home tab for an unbound window", async () => {
    seedSpaces([makeSpace({ id: "s1", windowId: 11, position: 1 })]);
    addTab({ windowId: 11, url: "https://a.test/" });
    addTab({ windowId: 55, url: "https://unbound.test/" }); // no space bound to 55

    const { restoreHomeTabsAfterUpdate } = await import("../spaces");
    await restoreHomeTabsAfterUpdate();

    expect(tabs.some((t) => t.windowId === 55 && t.url.startsWith(HOME_BASE))).toBe(
      false,
    );
  });
});

describe("openHomePage — anchored home tab", () => {
  beforeEach(() => installChromeStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("creates a home tab carrying the window's ?space= anchor", async () => {
    seedSpaces([makeSpace({ id: "s2", windowId: 22, position: 2 })]);
    addTab({ windowId: 22, url: "https://b.test/" });

    const { openHomePage } = await import("../messages");
    await openHomePage(22);

    const home = tabs.find(
      (t) => t.windowId === 22 && t.url.startsWith(HOME_BASE),
    );
    expect(home).toBeDefined();
    expect(home!.url).toBe(`${HOME_BASE}?space=s2`);
    expect(home!.pinned).toBe(true);
    expect(home!.active).toBe(true);
  });

  it("re-stamps and activates an existing un-anchored home tab instead of duplicating", async () => {
    seedSpaces([makeSpace({ id: "s2", windowId: 22, position: 2 })]);
    addTab({ windowId: 22, url: HOME_BASE, pinned: true, index: 0 });

    const { openHomePage } = await import("../messages");
    await openHomePage(22);

    const homeTabs = tabs.filter(
      (t) => t.windowId === 22 && t.url.startsWith(HOME_BASE),
    );
    expect(homeTabs).toHaveLength(1);
    expect(homeTabs[0].url).toBe(`${HOME_BASE}?space=s2`);
    expect(homeTabs[0].active).toBe(true);
  });
});
