import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("storage.getSpaces — instructions migration", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete store[key];
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

  it("defaults instructions to null for spaces stored without it", async () => {
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
      },
    ];
    const { storage } = await import("../storage");
    const spaces = await storage.getSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0].instructions).toBeNull();
  });

  it("preserves instructions when present", async () => {
    (globalThis as any).__store["spaces"] = [
      {
        id: "s2",
        name: "Research",
        icon: "📚",
        windowId: null,
        position: 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
        instructions: "Be concise.",
      },
    ];
    const { storage } = await import("../storage");
    const spaces = await storage.getSpaces();
    expect(spaces[0].instructions).toBe("Be concise.");
  });

  it("defaults updatedAt to a number for spaces stored without it", async () => {
    (globalThis as any).__store["spaces"] = [
      {
        id: "s3",
        name: "Legacy",
        icon: null,
        windowId: null,
        position: 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
      },
    ];
    const before = Date.now();
    const { storage } = await import("../storage");
    const spaces = await storage.getSpaces();
    const after = Date.now();
    expect(typeof spaces[0].updatedAt).toBe("number");
    expect(spaces[0].updatedAt).toBeGreaterThanOrEqual(before);
    expect(spaces[0].updatedAt).toBeLessThanOrEqual(after);
  });

  it("preserves updatedAt when present", async () => {
    (globalThis as any).__store["spaces"] = [
      {
        id: "s4",
        name: "Recent",
        icon: null,
        windowId: null,
        position: 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
        instructions: null,
        updatedAt: 1234567890,
      },
    ];
    const { storage } = await import("../storage");
    const spaces = await storage.getSpaces();
    expect(spaces[0].updatedAt).toBe(1234567890);
  });

  it("updateSpace bumps updatedAt for user-facing field changes", async () => {
    (globalThis as any).__store["spaces"] = [
      {
        id: "s5",
        name: "Old",
        icon: null,
        windowId: null,
        position: 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
        instructions: null,
        updatedAt: 1000,
      },
    ];
    const { storage } = await import("../storage");
    const before = Date.now();
    await storage.updateSpace("s5", { name: "New" });
    const after = Date.now();
    const spaces = await storage.getSpaces();
    expect(spaces[0].updatedAt).toBeGreaterThanOrEqual(before);
    expect(spaces[0].updatedAt).toBeLessThanOrEqual(after);
  });

  it("updateSpace does NOT bump updatedAt for system-only fields (windowId)", async () => {
    (globalThis as any).__store["spaces"] = [
      {
        id: "s6",
        name: "Old",
        icon: null,
        windowId: null,
        position: 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
        instructions: null,
        updatedAt: 9999,
      },
    ];
    const { storage } = await import("../storage");
    await storage.updateSpace("s6", { windowId: 42 });
    const spaces = await storage.getSpaces();
    expect(spaces[0].updatedAt).toBe(9999);
    expect(spaces[0].windowId).toBe(42);
  });
});
