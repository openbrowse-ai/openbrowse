import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  const windows = [
    { id: 1, focused: true, incognito: false, tabs: [{ id: 10, active: true, url: "https://a.com", title: "A" }] },
    { id: 2, focused: false, incognito: false, tabs: [] },
  ];
  const spaces = [
    { id: "sp1", name: "Work", description: null, position: 1, windowId: 1, instructions: null, pinnedTabs: [], favorites: [], icon: null, colors: null, colorMode: null, updatedAt: 0 },
  ];
  (globalThis as any).chrome = {
    windows: {
      getAll: vi.fn(async () => windows),
    },
    tabs: {
      query: vi.fn(async ({ windowId, active }: { windowId: number; active: boolean }) => {
        const w = windows.find((x) => x.id === windowId);
        if (!w) return [];
        if (active) return w.tabs.filter((t) => t.active);
        return w.tabs;
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: key === "spaces" ? spaces : undefined })),
        set: vi.fn(),
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.0.0-test" }),
    },
  };
});
afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/get-context", () => {
  it("returns focused window id and window summaries", async () => {
    const { handleGetContext } = await import("../get-context");
    const result = await handleGetContext({});
    expect(result.focusedWindowId).toBe(1);
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({
      windowId: 1,
      focused: true,
      tabCount: 1,
      activeTab: { id: 10, url: "https://a.com", title: "A" },
      space: { id: "sp1", name: "Work", description: null },
    });
    expect(result.windows[1]).toMatchObject({
      windowId: 2,
      focused: false,
      tabCount: 0,
      activeTab: null,
      space: null,
    });
  });

  it("includes broker/extension version metadata", async () => {
    const { handleGetContext } = await import("../get-context");
    const result = await handleGetContext({});
    expect(typeof result.brokerVersion).toBe("string");
    expect(typeof result.extensionVersion).toBe("string");
  });
});
