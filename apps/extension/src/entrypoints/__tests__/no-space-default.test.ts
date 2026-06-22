import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Space } from "@/lib/types";

const HOME_BASE = "chrome-extension://test/home.html";

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  pinned: boolean;
  index: number;
  active: boolean;
}

describe("no-space default — storage", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = { spaces: [] };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: store[k] })),
          set: vi.fn(async (o: any) => Object.assign(store, o)),
          remove: vi.fn(async (k: string) => {
            delete store[k];
          }),
        },
      },
    };
    (globalThis as any).__store = store;
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).__store;
    vi.resetModules();
  });

  it("storage.getSpaceByWindowId returns undefined when no spaces exist", async () => {
    const { storage } = await import("@/lib/storage");
    expect(await storage.getSpaceByWindowId(123)).toBeUndefined();
  });

  it("storage.getSpaceByWindowId returns undefined when no space matches the window", async () => {
    (globalThis as any).__store["spaces"] = [
      {
        id: "s1",
        name: "Space 1",
        icon: null,
        windowId: 42,
        position: 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
        instructions: null,
      },
    ];
    const { storage } = await import("@/lib/storage");
    expect(await storage.getSpaceByWindowId(999)).toBeUndefined();
    const found = await storage.getSpaceByWindowId(42);
    expect(found?.id).toBe("s1");
  });
});

/**
 * Behavioural guards that the spaceless default really is spaceless: the
 * background paths that previously force-created a space on first run must
 * no longer do so. These tests pin down `openHomePage` — the path triggered
 * by the toolbar action and the new-tab override.
 */
describe("no-space default — openHomePage does not auto-create", () => {
  let store: Record<string, unknown>;
  let tabs: FakeTab[];
  let nextTabId: number;

  beforeEach(() => {
    store = { spaces: [] };
    tabs = [];
    nextTabId = 1;

    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (p: string) =>
          `chrome-extension://test/${p.replace(/^\//, "")}`,
      },
      windows: {
        getAll: () => {
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
          if (q.windowId != null)
            res = res.filter((t) => t.windowId === q.windowId);
          if (q.pinned != null) res = res.filter((t) => t.pinned === q.pinned);
          return Promise.resolve(res.map((t) => ({ ...t })));
        },
        create: vi.fn(
          (props: {
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
              index:
                props.index ??
                tabs.filter((t) => t.windowId === props.windowId).length,
              active: props.active ?? false,
            };
            tabs.push(tab);
            return Promise.resolve({ ...tab });
          },
        ),
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function seedSpaces(spaces: Space[]) {
    store["spaces"] = spaces;
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

  it("openHomePage does not auto-create a space when none exists", async () => {
    // No spaces seeded. The window has an unrelated tab so chrome.tabs.query
    // returns sensibly.
    tabs.push({
      id: nextTabId++,
      windowId: 42,
      url: "https://example.test/",
      pinned: false,
      index: 0,
      active: true,
    });

    const { openHomePage } = await import("../background/messages");
    const { storage } = await import("@/lib/storage");

    await openHomePage(42);

    // No space was lazily created.
    expect(await storage.getSpaces()).toEqual([]);

    // A home tab was opened (un-anchored, since there's no space). The
    // home tab is OpenBrowse's app shell so it's pinned regardless of
    // whether a space is bound.
    const homeTabs = tabs.filter((t) => t.url.startsWith(HOME_BASE));
    expect(homeTabs).toHaveLength(1);
    expect(homeTabs[0].url).toBe(HOME_BASE);
    expect(homeTabs[0].url).not.toContain("?space=");
    expect(homeTabs[0].pinned).toBe(true);
    expect(homeTabs[0].active).toBe(true);
  });

  it("openHomePage does not auto-create when window has no bound space", async () => {
    // A space exists, but it's bound to a different window than the one we
    // open the home page in. The unbound window must not trigger creation.
    seedSpaces([makeSpace({ id: "s1", windowId: 11, position: 1 })]);
    tabs.push({
      id: nextTabId++,
      windowId: 99,
      url: "https://other.test/",
      pinned: false,
      index: 0,
      active: true,
    });

    const { openHomePage } = await import("../background/messages");
    const { storage } = await import("@/lib/storage");

    await openHomePage(99);

    const spaces = await storage.getSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0].id).toBe("s1");

    // The home tab opened in window 99 is un-anchored — there's no space
    // for that window — but still pinned (app-shell convention).
    const homeIn99 = tabs.find(
      (t) => t.windowId === 99 && t.url.startsWith(HOME_BASE),
    );
    expect(homeIn99).toBeDefined();
    expect(homeIn99!.url).toBe(HOME_BASE);
    expect(homeIn99!.url).not.toContain("?space=");
    expect(homeIn99!.pinned).toBe(true);
  });
});
