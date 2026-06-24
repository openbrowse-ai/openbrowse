/**
 * Tests for the chat-db v15 upgrade hop, which renames
 * `ownedTabIds: number[]` → `ownedLtids: string[]` and rewrites
 * `handleState.handles` values from chrome.tabs.id (number) to LogicalTabId
 * (UUID string).
 *
 * Uses fake-indexeddb to drive a real IndexedDB upgrade lifecycle so we can
 * seed v14-shaped rows, open the db at v15, and assert the migration
 * produced the expected v15 shape.
 */

import "fake-indexeddb/auto";
import { openDB } from "idb";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { chatDb } from "../chat-db";
import { tabRegistry } from "../agent/tab-registry";

/**
 * Seed a v14-shaped conversations object store. The columns we care about
 * are `ownedTabIds: number[]` and `handleState.handles: Record<string, number>`.
 * We don't need to faithfully simulate every prior schema bump — the v15 hop
 * only reads `ownedTabIds` and `handleState`, plus calls `cursor.update` on
 * the row in place.
 */
async function seedV14Row(row: {
  id: string;
  ownedTabIds: number[];
  handleState?: { handles: Record<string, number>; counter: number };
}): Promise<void> {
  // Open at v14 with the minimum schema needed to write a row, mirroring
  // what an existing user's IndexedDB looks like before the upgrade.
  const db = await openDB("openbrowse-chat", 14, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("conversations")) {
        const s = db.createObjectStore("conversations", { keyPath: "id" });
        s.createIndex("by-updated", "updatedAt");
        s.createIndex("by-space", "spaceId");
        s.createIndex("by-parent", "parentConversationId");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const m = db.createObjectStore("messages", { keyPath: "id" });
        m.createIndex("by-conversation", "conversationId");
      }
      if (!db.objectStoreNames.contains("scheduledTasks")) {
        const t = db.createObjectStore("scheduledTasks", { keyPath: "id" });
        t.createIndex("by-next-run", "nextRunAt");
      }
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record: any = {
    id: row.id,
    title: "t",
    spaceId: null,
    ownedGroupId: null,
    ownedTabIds: row.ownedTabIds,
    parentConversationId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  if (row.handleState) {
    record.handleState = row.handleState;
  }
  await db.put("conversations", record);
  db.close();
}

/** Read the raw row past the typed chatDb wrapper to inspect post-migration shape. */
async function readRowRaw(id: string): Promise<Record<string, unknown> | undefined> {
  // chatDb.getDb is private; use the raw factory at the current schema
  // chatDb.getDb is private; use the raw factory at the current schema
  // version. Must be ≥ the current chat-db version (the v15 migration
  // shipped at v15; subsequent bumps mean we re-open here at the latest
  // version to read the post-migration shape). Currently v17
  // (v16 = tool-input shape sweep, v17 = approval-mode mode/plan fields).
  const db = await openDB("openbrowse-chat", 17);
  const v = await db.get("conversations", id);
  db.close();
  return v as unknown as Record<string, unknown> | undefined;
}

describe("chatDb v15 migration: ownedTabIds → ownedLtids", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
  });

  afterEach(() => {
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    vi.restoreAllMocks();
  });

  it("migrates a row with mixed live/dead ctids — drops dead, mints ltids for live", async () => {
    // Stub chrome.tabs.get: ctid 42 is alive, 99 throws (dead).
    vi.stubGlobal("chrome", {
      ...((globalThis as { chrome?: unknown }).chrome ?? {}),
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        get: (id: number) => {
          if (id === 42) return Promise.resolve({ id: 42, url: "https://x" });
          return Promise.reject(new Error("no tab"));
        },
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(undefined),
      },
    });

    await seedV14Row({
      id: "c1",
      ownedTabIds: [42, 99],
      handleState: { handles: { t1: 42, t2: 99 }, counter: 3 },
    });

    // Trigger the upgrade by opening the db through chatDb's factory.
    await chatDb.listConversations();

    const row = await readRowRaw("c1");
    expect(row).toBeDefined();
    expect(row!.ownedTabIds).toBeUndefined(); // legacy field removed
    const ownedLtids = row!.ownedLtids as string[];
    expect(ownedLtids).toHaveLength(1);
    const ltid42 = ownedLtids[0];
    expect(typeof ltid42).toBe("string");
    expect(ltid42.length).toBeGreaterThan(0);

    // Handle map: t1 should rewrite to the ltid we minted for 42; t2 dropped.
    const hs = row!.handleState as
      | { handles: Record<string, string>; counter: number }
      | undefined;
    expect(hs).toBeDefined();
    expect(hs!.handles).toEqual({ t1: ltid42 });
    expect(hs!.counter).toBe(3);
  });

  it("degrades a corrupt row to empty owned-state and warns", async () => {
    vi.stubGlobal("chrome", {
      ...((globalThis as { chrome?: unknown }).chrome ?? {}),
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        // Make tabs.get throw synchronously (the registration loop awaits
        // it). We don't want this to be the failure case though — that
        // path is "tab dead, drop", not "throw and degrade". Instead we
        // make ownedTabIds itself a getter that throws on read inside
        // the try block.
        get: () => Promise.resolve({ id: 0, url: "" }),
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(undefined),
      },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Seed a normal-looking v14 row, then re-open the db at v14 and
    // overwrite the row with a poison-pill payload whose `ownedTabIds`
    // getter throws on read. fake-indexeddb's structured-clone path
    // refuses to serialize getters, so instead we use a non-array,
    // non-iterable ownedTabIds value that crashes the `for (const ctid
    // of legacyTabIds)` loop's iterator after Array.isArray fails. We
    // achieve this by making the migration's downstream `Object.entries`
    // see a Proxy that throws on iteration.
    //
    // Simpler: directly check that an exception inside the inner loop
    // routes to the catch by making `tabRegistry.registerExisting` throw.
    const realRegister = tabRegistry.registerExisting;
    let calls = 0;
    tabRegistry.registerExisting = ((ctid: number) => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic register failure");
      return realRegister(ctid);
    }) as typeof realRegister;

    await seedV14Row({
      id: "c-broken",
      ownedTabIds: [42],
    });

    try {
      await chatDb.listConversations();
    } finally {
      tabRegistry.registerExisting = realRegister;
    }

    const row = await readRowRaw("c-broken");
    expect(row).toBeDefined();
    expect(row!.ownedTabIds).toBeUndefined();
    expect(row!.ownedLtids).toEqual([]);
    expect(row!.handleState).toBeUndefined();

    // The migration's catch path warns; multiple warns may fire (e.g.
    // tab-registry's onReplaced telemetry may also have fired). Check that
    // ours appears.
    const v15warns = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("[chat-db v15]"),
    );
    expect(v15warns.length).toBeGreaterThan(0);
  });

  it("migrates an empty row to ownedLtids: [] with no handleState", async () => {
    vi.stubGlobal("chrome", {
      ...((globalThis as { chrome?: unknown }).chrome ?? {}),
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        get: () => Promise.reject(new Error("none")),
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(undefined),
      },
    });

    await seedV14Row({ id: "empty", ownedTabIds: [] });

    await chatDb.listConversations();

    const row = await readRowRaw("empty");
    expect(row!.ownedTabIds).toBeUndefined();
    expect(row!.ownedLtids).toEqual([]);
    expect(row!.handleState).toBeUndefined();
  });

  it("preserves the handle counter when handle map is empty post-migration", async () => {
    vi.stubGlobal("chrome", {
      ...((globalThis as { chrome?: unknown }).chrome ?? {}),
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        get: () => Promise.reject(new Error("dead")),
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(undefined),
      },
    });

    // All ctids are dead → all handles drop, but counter=7 should persist
    // (so newly-minted handles continue from t7 and don't collide with
    // earlier message text mentioning t1..t6).
    await seedV14Row({
      id: "c-counter",
      ownedTabIds: [1, 2, 3],
      handleState: { handles: { t1: 1, t2: 2, t3: 3 }, counter: 7 },
    });

    await chatDb.listConversations();

    const row = await readRowRaw("c-counter");
    expect(row!.ownedLtids).toEqual([]);
    const hs = row!.handleState as
      | { handles: Record<string, string>; counter: number }
      | undefined;
    expect(hs).toBeDefined();
    expect(hs!.handles).toEqual({});
    expect(hs!.counter).toBe(7);
  });

  it("is idempotent — re-opening at v15 doesn't re-migrate", async () => {
    vi.stubGlobal("chrome", {
      ...((globalThis as { chrome?: unknown }).chrome ?? {}),
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        get: (id: number) => Promise.resolve({ id, url: "https://x" }),
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(undefined),
      },
    });

    await seedV14Row({ id: "c1", ownedTabIds: [42] });

    // First open triggers the v14 → v15 upgrade.
    await chatDb.listConversations();
    const row1 = await readRowRaw("c1");
    const ltid1 = (row1!.ownedLtids as string[])[0];

    // Reset chatDb's connection cache so the next call re-opens (which,
    // because the schema is at v15, should run no upgrade hop and
    // touch nothing).
    chatDb._resetForTests();

    await chatDb.listConversations();
    const row2 = await readRowRaw("c1");
    expect((row2!.ownedLtids as string[])[0]).toBe(ltid1);
  });
});
