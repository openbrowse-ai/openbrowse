import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryIndexDb, type LegacyMemory } from "@/lib/memory-db";
import { installFakeOpfs, type FakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";
import { memoryFilePath } from "../format";
import { migrateMemoryV2 } from "../migrate";
import { memoryStore } from "../store";

let fake: FakeOpfs;

/** Minimal chrome.storage.local stub backed by a Map, for the flag guard. */
function installChromeStorage() {
  const map = new Map<string, unknown>();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(key: string) {
          return map.has(key) ? { [key]: map.get(key) } : {};
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) map.set(k, v);
        },
      },
    },
  });
  return map;
}

function legacy(
  partial: Partial<LegacyMemory> & { title: string },
): LegacyMemory {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: "reference",
    description: "desc",
    content: "body",
    domain: null,
    spaceId: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

beforeEach(() => {
  indexedDB = new IDBFactory();
  memoryIndexDb._resetForTests();
  fake = installFakeOpfs(vi);
  installChromeStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migrateMemoryV2", () => {
  it("rewrites legacy rows as flat v2 files + index rows", async () => {
    await memoryIndexDb._seedLegacyForTests([
      legacy({ title: "User Name", content: "Ada", spaceId: null }),
      legacy({
        title: "Repo URL",
        content: "openbrowse-ai/openbrowse",
        spaceId: "space-1",
      }),
    ]);

    // Pass the known space id so reconcile indexes the scoped file too.
    const n = await migrateMemoryV2(["space-1"]);
    expect(n).toBe(2);

    // Files landed flat under each scope's memory root.
    const globalPath = memoryFilePath("user-name", null);
    const spacePath = memoryFilePath("repo-url", "space-1");
    expect([...fake.files.keys()]).toContain(globalPath);
    expect([...fake.files.keys()]).toContain(spacePath);

    const globalRow = await memoryStore.get(globalPath);
    expect(globalRow?.content).toBe("Ada");
    expect(globalRow?.scope).toBe("user");

    const spaceRow = await memoryStore.get(spacePath);
    expect(spaceRow?.content).toBe("openbrowse-ai/openbrowse");
    expect(spaceRow?.scope).toBe("space");
    // A creation timeline entry is seeded so history has an origin.
    const text = new TextDecoder().decode(fake.files.get(globalPath)!);
    expect(text).toContain("Migrated from v1 memory");
  });

  it("does not collide when two legacy rows share a slug in one scope", async () => {
    await memoryIndexDb._seedLegacyForTests([
      legacy({ title: "Dup", content: "first" }),
      legacy({ title: "Dup", content: "second" }),
    ]);
    const n = await migrateMemoryV2();
    expect(n).toBe(2);
    expect([...fake.files.keys()]).toContain(memoryFilePath("dup", null));
    expect([...fake.files.keys()]).toContain("memory/dup-2.md");
  });

  it("is idempotent — a second run migrates nothing (flag guard)", async () => {
    await memoryIndexDb._seedLegacyForTests([
      legacy({ title: "Once", content: "x" }),
    ]);
    expect(await migrateMemoryV2()).toBe(1);
    expect(await migrateMemoryV2()).toBe(0);
  });

  it("returns 0 when there is nothing to migrate", async () => {
    expect(await migrateMemoryV2()).toBe(0);
  });
});
