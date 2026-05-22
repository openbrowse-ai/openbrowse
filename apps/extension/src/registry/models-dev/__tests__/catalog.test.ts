import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  _resetCacheForTests,
  getCatalog,
  getLastUpdated,
  refreshCatalog,
} from "../catalog";

// Stub chrome.storage.local for the catalog module under test.
type StorageBag = Record<string, unknown>;
const storage: StorageBag = {};

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage[key] }),
      set: async (entries: StorageBag) => {
        Object.assign(storage, entries);
      },
    },
  },
});

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
  _resetCacheForTests();
});

describe("catalog cache fallback", () => {
  it("returns the bundled snapshot when storage is empty (offline first run)", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network should not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const catalog = await getCatalog();
    expect(Object.keys(catalog).length).toBeGreaterThan(50);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null lastUpdated when never refreshed", async () => {
    expect(await getLastUpdated()).toBeNull();
  });
});

describe("refreshCatalog freshness gate", () => {
  it("skips network when cache is fresh (within 5 min)", async () => {
    storage["models-dev-catalog"] = {
      catalog: { foo: { id: "foo", name: "Foo", env: [], models: {} } },
      fetchedAt: Date.now(),
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshCatalog();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches when forced even if fresh", async () => {
    storage["models-dev-catalog"] = {
      catalog: { foo: { id: "foo", name: "Foo", env: [], models: {} } },
      fetchedAt: Date.now(),
    };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        bar: { id: "bar", name: "Bar", env: [], models: {} },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshCatalog({ force: true });
    expect(result).not.toBeNull();
    expect(result!.providerCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null on fetch failure (no exception)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const result = await refreshCatalog({ force: true });
    expect(result).toBeNull();
  });
});
