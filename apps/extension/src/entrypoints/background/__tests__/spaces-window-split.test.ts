import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeWindow {
  id: number;
  focused: boolean;
  tabs?: { id: number; pinned: boolean; url?: string; active?: boolean }[];
}

function setupChromeFakes(existingWindows: FakeWindow[] = []) {
  const windows = new Map<number, FakeWindow>();
  for (const w of existingWindows) windows.set(w.id, { ...w });
  let nextWindowId = 1000;
  let nextTabId = 5000;
  const spacesStore: Record<string, unknown> = { spaces: [] };

  (globalThis as any).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p.replace(/^\//, "")}`,
    },
    windows: {
      get: vi.fn(async (id: number) => {
        const w = windows.get(id);
        if (!w) throw new Error("no such window");
        return w;
      }),
      update: vi.fn(async (id: number, opts: { focused?: boolean }) => {
        const w = windows.get(id);
        if (!w) throw new Error("no such window");
        if (opts.focused) w.focused = true;
        return w;
      }),
      create: vi.fn(async (opts: { url: string[]; focused?: boolean }) => {
        const id = nextWindowId++;
        const tabs = opts.url.map((url) => ({ id: nextTabId++, pinned: false, url, active: false }));
        const win: FakeWindow = { id, focused: !!opts.focused, tabs };
        windows.set(id, win);
        return win;
      }),
    },
    tabs: {
      update: vi.fn(async (tabId: number, opts: { pinned?: boolean; active?: boolean }) => {
        for (const w of windows.values()) {
          const t = w.tabs?.find((x) => x.id === tabId);
          if (t) {
            if (opts.pinned !== undefined) t.pinned = opts.pinned;
            if (opts.active !== undefined) t.active = opts.active;
            return t;
          }
        }
        throw new Error("no such tab");
      }),
      query: vi.fn(async ({ windowId }: { windowId: number }) => {
        return windows.get(windowId)?.tabs ?? [];
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: spacesStore[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(spacesStore, obj);
        }),
      },
    },
  };
  return { windows, spacesStore };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("spaces window split", () => {
  it("ensureWindowForSpace returns existing windowId when window is live (no focus side-effect)", async () => {
    setupChromeFakes([{ id: 100, focused: false }]);
    const { ensureWindowForSpace } = await import("../spaces");
    const space = {
      id: "sp1",
      name: "S",
      icon: null,
      windowId: 100,
      position: 1,
      favorites: [],
      pinnedTabs: [],
      colors: null,
      colorMode: null,
      instructions: null,
      description: null,
      updatedAt: Date.now(),
    };
    const wid = await ensureWindowForSpace(space);
    expect(wid).toBe(100);
    // Should NOT have focused the window
    const calls = ((globalThis as any).chrome.windows.update as any).mock.calls;
    const focusCalls = calls.filter((c: any[]) => c[1]?.focused === true);
    expect(focusCalls.length).toBe(0);
  });

  it("ensureWindowForSpace creates a window when windowId is null", async () => {
    setupChromeFakes([]);
    const { ensureWindowForSpace } = await import("../spaces");
    const space = {
      id: "sp2",
      name: "S",
      icon: null,
      windowId: null,
      position: 1,
      favorites: [],
      pinnedTabs: [],
      colors: null,
      colorMode: null,
      instructions: null,
      description: null,
      updatedAt: Date.now(),
    };
    const wid = await ensureWindowForSpace(space);
    expect(typeof wid).toBe("number");
    expect((globalThis as any).chrome.windows.create).toHaveBeenCalled();
  });

  it("focusSpace focuses the bound window", async () => {
    setupChromeFakes([{ id: 200, focused: false }]);
    const { focusSpace } = await import("../spaces");
    const space = {
      id: "sp3",
      name: "S",
      icon: null,
      windowId: 200,
      position: 1,
      favorites: [],
      pinnedTabs: [],
      colors: null,
      colorMode: null,
      instructions: null,
      description: null,
      updatedAt: Date.now(),
    };
    await focusSpace(space);
    const calls = ((globalThis as any).chrome.windows.update as any).mock.calls;
    expect(calls.some((c: any[]) => c[0] === 200 && c[1]?.focused === true)).toBe(true);
  });

  it("focusOrCreateWindow remains as a wrapper combining the two", async () => {
    setupChromeFakes([]);
    const { focusOrCreateWindow } = await import("../spaces");
    const space = {
      id: "sp4",
      name: "S",
      icon: null,
      windowId: null,
      position: 1,
      favorites: [],
      pinnedTabs: [],
      colors: null,
      colorMode: null,
      instructions: null,
      description: null,
      updatedAt: Date.now(),
    };
    await focusOrCreateWindow(space);
    // Should have created a window
    expect((globalThis as any).chrome.windows.create).toHaveBeenCalled();
    // And focused it
    const updateCalls = ((globalThis as any).chrome.windows.update as any).mock.calls;
    expect(updateCalls.some((c: any[]) => c[1]?.focused === true)).toBe(true);
  });
});
