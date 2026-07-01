import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  const windows = [
    { id: 1, focused: false, incognito: false, tabs: [{ id: 10, active: true, url: "https://a.com", title: "A" }] },
    { id: 2, focused: true, incognito: false, tabs: [{ id: 20, active: true, url: "https://b.com", title: "B" }, { id: 21, active: false, url: "x", title: "x" }] },
  ];
  (globalThis as any).chrome = {
    windows: { getAll: vi.fn(async () => windows) },
    tabs: {
      query: vi.fn(async ({ windowId, active }: { windowId: number; active?: boolean }) => {
        const w = windows.find((x) => x.id === windowId);
        if (!w) return [];
        return active ? w.tabs.filter((t) => t.active) : w.tabs;
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ spaces: [] })),
      },
    },
  };
});
afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/list-windows", () => {
  it("returns all windows with active-tab and counts", async () => {
    const { handleListWindows } = await import("../list-windows");
    const result = await handleListWindows({});
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({ windowId: 1, focused: false, tabCount: 1 });
    expect(result.windows[1]).toMatchObject({ windowId: 2, focused: true, tabCount: 2 });
    expect(result.windows[1].activeTab).toMatchObject({ id: 20, url: "https://b.com", title: "B" });
  });
});
