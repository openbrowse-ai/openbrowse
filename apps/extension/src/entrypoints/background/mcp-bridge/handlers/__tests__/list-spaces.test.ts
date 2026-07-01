import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseSpace = {
  id: "x",
  name: "X",
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
};

beforeEach(() => {
  const liveWindowIds = new Set([100]);
  const spaces = [
    { ...baseSpace, id: "sp1", name: "Work", description: "for work", windowId: 100, instructions: "be concise", position: 1 },
    { ...baseSpace, id: "sp2", name: "Personal", description: null, windowId: 999, position: 2 },  // dead window
    { ...baseSpace, id: "sp3", name: "Unbound", description: null, windowId: null, position: 3 },
  ];
  (globalThis as any).chrome = {
    storage: { local: { get: vi.fn(async () => ({ spaces })) } },
    windows: {
      get: vi.fn(async (id: number) => {
        if (liveWindowIds.has(id)) return { id, focused: false };
        throw new Error("no such window");
      }),
    },
  };
});
afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/list-spaces", () => {
  it("returns spaces with `bound` reflecting live window status", async () => {
    const { handleListSpaces } = await import("../list-spaces");
    const result = await handleListSpaces({});
    expect(result.spaces).toHaveLength(3);
    expect(result.spaces[0]).toMatchObject({
      id: "sp1", name: "Work", description: "for work",
      position: 1, bound: true, windowId: 100, hasInstructions: true,
    });
    expect(result.spaces[1]).toMatchObject({ id: "sp2", bound: false, windowId: 999 });
    expect(result.spaces[2]).toMatchObject({ id: "sp3", bound: false, windowId: null });
  });

  it("returns empty array when user has no spaces", async () => {
    (globalThis as any).chrome.storage.local.get = vi.fn(async () => ({ spaces: [] }));
    const { handleListSpaces } = await import("../list-spaces");
    const result = await handleListSpaces({});
    expect(result.spaces).toEqual([]);
  });
});
