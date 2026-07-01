import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("storage — spaces concurrency", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = { spaces: [] };
    let setDelayMs = 0;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            if (setDelayMs > 0) await new Promise((r) => setTimeout(r, setDelayMs));
            Object.assign(store, obj);
          }),
        },
      },
    };
    (globalThis as any).__setDelay = (ms: number) => { setDelayMs = ms; };
    (globalThis as any).__store = store;
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).__store;
    delete (globalThis as any).__setDelay;
    vi.resetModules();
  });

  it("concurrent updateSpace calls are serialized", async () => {
    const { storage } = await import("@/lib/storage");
    const baseSpace = {
      id: "sp1",
      name: "Original",
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
    (globalThis as any).__store.spaces = [baseSpace];
    (globalThis as any).__setDelay(20);

    // Fire two concurrent updates. Without lockSpaces, the second would race
    // and read stale data.
    const p1 = storage.updateSpace("sp1", { name: "Update A" });
    const p2 = storage.updateSpace("sp1", { description: "Update B" });
    await Promise.all([p1, p2]);

    const final = (globalThis as any).__store.spaces[0];
    // Both updates should be present (no lost write)
    expect(final.name).toBe("Update A");
    expect(final.description).toBe("Update B");
  });
});
