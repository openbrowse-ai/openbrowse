import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Space } from "@/lib/types";

/**
 * Behavioural guards for `chrome.windows.onCreated` → auto-pinned home tab.
 *
 * The bug this pins down: a brand-new normal window (e.g. ⌘N from any
 * window in a spaceless install) must end up with a single pinned home tab
 * at index 0, without manual intervention. Earlier the listener used a
 * 50ms `setTimeout` that races MV3 service-worker eviction; tests here
 * exercise the post-fix listener directly via `handleNewWindowAutoHome`.
 */

const HOME_BASE = "chrome-extension://test/home.html";

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  pendingUrl?: string;
  pinned: boolean;
  index: number;
  active: boolean;
}

describe("handleNewWindowAutoHome", () => {
  let store: Record<string, unknown>;
  let tabs: FakeTab[];
  let nextTabId: number;

  beforeEach(() => {
    store = { spaces: [] };
    tabs = [];
    nextTabId = 1;

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        getURL: (p: string) =>
          `chrome-extension://test/${p.replace(/^\//, "")}`,
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
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
        onCreated: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {}, removeListener: () => {} },
      },
      tabs: {
        onCreated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        query: (q: { windowId?: number; pinned?: boolean }) => {
          let res = tabs.slice();
          if (q.windowId != null)
            res = res.filter((t) => t.windowId === q.windowId);
          if (q.pinned != null) res = res.filter((t) => t.pinned === q.pinned);
          return Promise.resolve(res.map((t) => ({ ...t })));
        },
        get: (id: number) => {
          const t = tabs.find((x) => x.id === id);
          return t
            ? Promise.resolve({ ...t })
            : Promise.reject(new Error("no tab"));
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
        remove: (id: number | number[]) => {
          const ids = Array.isArray(id) ? id : [id];
          for (const i of ids) {
            const idx = tabs.findIndex((t) => t.id === i);
            if (idx >= 0) tabs.splice(idx, 1);
          }
          return Promise.resolve();
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

  it("creates a pinned home tab on a fresh normal window with no spaces", async () => {
    // Simulate Chrome creating a new window with one initial chrome://newtab/
    // tab. handleNewWindowAutoHome must add a pinned home tab at index 0.
    tabs.push({
      id: nextTabId++,
      windowId: 42,
      url: "chrome://newtab/",
      pinned: false,
      index: 0,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 42,
      type: "normal",
    } as chrome.windows.Window);

    const homeTabs = tabs.filter(
      (t) => t.windowId === 42 && t.url.startsWith(HOME_BASE),
    );
    expect(homeTabs).toHaveLength(1);
    expect(homeTabs[0].pinned).toBe(true);
    expect(homeTabs[0].index).toBe(0);
    expect(homeTabs[0].url).toBe(HOME_BASE);
    expect(homeTabs[0].url).not.toContain("?space=");
  });

  it("closes the override-supplied newtab.html after creating the pinned home tab", async () => {
    // With chrome_url_overrides.newtab set in the manifest, Chrome opens a
    // new normal window (Cmd-N) with `newtab.html` as the initial tab,
    // not `chrome://newtab/`. handleNewWindowAutoHome must:
    //   1. Create the pinned home tab.
    //   2. Close the original newtab.html so the user lands on a single
    //      pinned home tab instead of a redundant two-tab window.
    // Removing the newtab is only safe AFTER the home tab exists (Chrome
    // closes the entire window if you remove its last tab).
    tabs.push({
      id: nextTabId++,
      windowId: 55,
      url: "chrome-extension://test/newtab.html",
      pinned: false,
      index: 0,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 55,
      type: "normal",
    } as chrome.windows.Window);

    const winTabs = tabs.filter((t) => t.windowId === 55);
    expect(winTabs).toHaveLength(1);
    expect(winTabs[0].url).toBe(HOME_BASE);
    expect(winTabs[0].pinned).toBe(true);
    expect(winTabs[0].index).toBe(0);
  });

  it("closes the newtab when chrome reports it as a pre-resolution chrome://newtab/ pendingUrl", async () => {
    // Production reality on Cmd-N with chrome_url_overrides.newtab set:
    // when auto-home fires, Chrome has put `chrome://newtab/` into
    // `pendingUrl` but hasn't yet resolved the override to
    // `chrome-extension://<id>/newtab.html` (the navigation hasn't
    // committed yet, so `url` is empty). The earlier filter only
    // matched the resolved chrome-extension URL and missed this shape,
    // leaving the newtab tab alongside the pinned home tab in
    // production. The filter must also recognize this pre-resolution
    // form (verified via service-worker logs).
    tabs.push({
      id: nextTabId++,
      windowId: 66,
      url: "",
      pendingUrl: "chrome://newtab/",
      pinned: false,
      index: 0,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 66,
      type: "normal",
    } as chrome.windows.Window);

    const winTabs = tabs.filter((t) => t.windowId === 66);
    expect(winTabs).toHaveLength(1);
    expect(winTabs[0].url).toBe(HOME_BASE);
    expect(winTabs[0].pinned).toBe(true);
    expect(winTabs[0].index).toBe(0);
  });

  it("closes the override-supplied newtab even when an existing home tab is already in the window", async () => {
    // Edge case: a window may end up with BOTH a pinned home tab (e.g.
    // from a prior repair, or `focusOrCreateWindow` injected one) AND
    // the override-supplied newtab tab. The cleanup must run regardless
    // of whether the home tab was just created or was already there.
    // Without the existing-home branch calling closeInitialNewtabs, the
    // newtab would survive and the user would see two tabs.
    tabs.push({
      id: nextTabId++,
      windowId: 77,
      url: HOME_BASE,
      pinned: true,
      index: 0,
      active: false,
    });
    tabs.push({
      id: nextTabId++,
      windowId: 77,
      url: "",
      pendingUrl: "chrome://newtab/",
      pinned: false,
      index: 1,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 77,
      type: "normal",
    } as chrome.windows.Window);

    const winTabs = tabs.filter((t) => t.windowId === 77);
    expect(winTabs).toHaveLength(1);
    expect(winTabs[0].url).toBe(HOME_BASE);
    expect(winTabs[0].pinned).toBe(true);
  });

  it("ignores popup-type windows", async () => {
    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 7,
      type: "popup",
    } as chrome.windows.Window);

    expect(tabs.filter((t) => t.url.startsWith(HOME_BASE))).toHaveLength(0);
  });

  it("ignores windows with id == null", async () => {
    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      type: "normal",
    } as chrome.windows.Window);

    expect(tabs.filter((t) => t.url.startsWith(HOME_BASE))).toHaveLength(0);
  });

  it("does not duplicate the home tab when the gate is set (focusOrCreateWindow path)", async () => {
    // Simulate focusOrCreateWindow: it created a new window with an
    // anchored home tab among the initial URLs and marked the window via
    // markAutoHomeOwned.
    seedSpaces([makeSpace({ id: "s1", windowId: 55, position: 1 })]);
    tabs.push({
      id: nextTabId++,
      windowId: 55,
      url: `${HOME_BASE}?space=s1`,
      pinned: true,
      index: 0,
      active: true,
    });
    const { markAutoHomeOwned } = await import("../background/spaces");
    markAutoHomeOwned(55);

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 55,
      type: "normal",
    } as chrome.windows.Window);

    const homeTabs = tabs.filter(
      (t) => t.windowId === 55 && t.url.startsWith(HOME_BASE),
    );
    expect(homeTabs).toHaveLength(1);
    // The original anchored home tab is untouched.
    expect(homeTabs[0].url).toBe(`${HOME_BASE}?space=s1`);
  });

  it("repairs an existing un-pinned home tab on a fresh window", async () => {
    // Simulate: user dragged a home tab into its own new window. It exists
    // but is unpinned. Auto-home must pin it (and not create a duplicate).
    tabs.push({
      id: nextTabId++,
      windowId: 88,
      url: HOME_BASE,
      pinned: false,
      index: 0,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 88,
      type: "normal",
    } as chrome.windows.Window);

    const homeTabs = tabs.filter(
      (t) => t.windowId === 88 && t.url.startsWith(HOME_BASE),
    );
    expect(homeTabs).toHaveLength(1);
    expect(homeTabs[0].pinned).toBe(true);
  });

  it("does not duplicate when onCreated fires before markAutoHomeOwned (early-dispatch race)", async () => {
    // Simulate the early-dispatch ordering: Chrome dispatches `onCreated`
    // BEFORE `chrome.windows.create`'s promise resolves in the caller, so
    // `focusOrCreateWindow`'s post-create `markAutoHomeOwned(id)` hasn't
    // run yet at the moment `handleNewWindowAutoHome` is invoked.
    //
    // The window already has the anchored home tab the creator passed to
    // `chrome.windows.create({ url: [homeUrl, ...] })`, but the tab is
    // still loading: its `url` is empty and the real URL lives in
    // `pendingUrl`.
    seedSpaces([makeSpace({ id: "s2", windowId: 77, position: 1 })]);
    tabs.push({
      id: nextTabId++,
      windowId: 77,
      url: "",
      pendingUrl: `${HOME_BASE}?space=s2`,
      pinned: false,
      index: 0,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    const { markAutoHomeOwned } = await import("../background/spaces");
    const handlerPromise = handleNewWindowAutoHome({
      id: 77,
      type: "normal",
    } as chrome.windows.Window);

    // Mark ownership a microtask later — emulating the creator's
    // continuation running between the listener's setTimeout(0) yield and
    // its gate check.
    queueMicrotask(() => markAutoHomeOwned(77));

    await handlerPromise;

    const homeTabs = tabs.filter(
      (t) =>
        t.windowId === 77 &&
        (t.url.startsWith(HOME_BASE) || t.pendingUrl?.startsWith(HOME_BASE)),
    );
    // Must NOT have created a second pinned home tab. The original
    // anchored (still-loading) home tab is the only one.
    expect(homeTabs).toHaveLength(1);
    expect(homeTabs[0].pendingUrl).toBe(`${HOME_BASE}?space=s2`);
  });

  it("reuses a still-loading home tab matched via pendingUrl", async () => {
    // Defense in depth: even if the gate is missed entirely (no
    // `markAutoHomeOwned` ever called), `openHomePage` itself must not
    // double-create — it should detect the loading home tab via its
    // `pendingUrl` and reuse it.
    tabs.push({
      id: nextTabId++,
      windowId: 99,
      url: "",
      pendingUrl: HOME_BASE,
      pinned: false,
      index: 0,
      active: true,
    });

    const { handleNewWindowAutoHome } = await import("../background/auto-home");
    await handleNewWindowAutoHome({
      id: 99,
      type: "normal",
    } as chrome.windows.Window);

    const homeTabs = tabs.filter(
      (t) =>
        t.windowId === 99 &&
        (t.url.startsWith(HOME_BASE) || t.pendingUrl?.startsWith(HOME_BASE)),
    );
    expect(homeTabs).toHaveLength(1);
    // The existing tab was pinned/activated, not duplicated.
    expect(homeTabs[0].pinned).toBe(true);
    expect(homeTabs[0].active).toBe(true);
  });
});

describe("openHomePage — pin verification belt-and-suspenders", () => {
  let tabs: FakeTab[];
  let nextTabId: number;
  let firstCreateDroppedPin: boolean;

  beforeEach(() => {
    const store: Record<string, unknown> = { spaces: [] };
    tabs = [];
    nextTabId = 1;
    firstCreateDroppedPin = true;

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        getURL: (p: string) =>
          `chrome-extension://test/${p.replace(/^\//, "")}`,
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
      },
      windows: {
        getAll: () => Promise.resolve([]),
        update: (id: number) => Promise.resolve({ id }),
        onCreated: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {}, removeListener: () => {} },
      },
      tabs: {
        onCreated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        query: (q: { windowId?: number }) => {
          let res = tabs.slice();
          if (q.windowId != null)
            res = res.filter((t) => t.windowId === q.windowId);
          return Promise.resolve(res.map((t) => ({ ...t })));
        },
        get: (id: number) => {
          const t = tabs.find((x) => x.id === id);
          return t
            ? Promise.resolve({ ...t })
            : Promise.reject(new Error("no tab"));
        },
        create: (props: {
          windowId: number;
          url: string;
          pinned?: boolean;
          index?: number;
          active?: boolean;
        }) => {
          // Simulate buggy Chrome that drops `pinned: true` on the first
          // tabs.create call after a fresh window — exactly the failure
          // mode the belt-and-suspender check exists to repair.
          const dropPin = firstCreateDroppedPin;
          firstCreateDroppedPin = false;
          const tab: FakeTab = {
            id: nextTabId++,
            windowId: props.windowId,
            url: props.url,
            pinned: dropPin ? false : (props.pinned ?? false),
            index:
              props.index ??
              tabs.filter((t) => t.windowId === props.windowId).length,
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
        remove: (id: number | number[]) => {
          const ids = Array.isArray(id) ? id : [id];
          for (const i of ids) {
            const idx = tabs.findIndex((t) => t.id === i);
            if (idx >= 0) tabs.splice(idx, 1);
          }
          return Promise.resolve();
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

  it("forces pinned: true even when chrome.tabs.create drops the flag", async () => {
    const { openHomePage } = await import("../background/messages");
    await openHomePage(123);

    const homeTabs = tabs.filter((t) => t.url.startsWith(HOME_BASE));
    expect(homeTabs).toHaveLength(1);
    // Despite the simulated buggy create call dropping pinned, the
    // verification step in openHomePage must repair it.
    expect(homeTabs[0].pinned).toBe(true);
  });
});
