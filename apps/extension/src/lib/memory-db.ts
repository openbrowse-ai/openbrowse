import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface Memory {
  id: string;
  type: "user" | "feedback" | "reference";
  title: string;
  description: string;
  content: string;
  domain: string | null;
  spaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MemoryDB extends DBSchema {
  memories: {
    key: string;
    value: Memory;
    indexes: {
      "by-space": string;
      "by-type": string;
      "by-domain": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<MemoryDB>> | null = null;

function getDb(): Promise<IDBPDatabase<MemoryDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MemoryDB>("openbrowse-memory", 1, {
      upgrade(db) {
        const store = db.createObjectStore("memories", { keyPath: "id" });
        store.createIndex("by-space", "spaceId");
        store.createIndex("by-type", "type");
        store.createIndex("by-domain", "domain");
      },
    });
  }
  return dbPromise;
}

export const memoryDb = {
  async list(spaceId: string | null): Promise<Memory[]> {
    const db = await getDb();
    const all = await db.getAll("memories");
    return all.filter(
      (m) => m.spaceId === null || m.spaceId === spaceId,
    );
  },

  async getByDomain(domain: string): Promise<Memory[]> {
    const db = await getDb();
    return db.getAllFromIndex("memories", "by-domain", domain);
  },

  async get(id: string): Promise<Memory | undefined> {
    const db = await getDb();
    return db.get("memories", id);
  },

  async save(memory: Memory): Promise<void> {
    const db = await getDb();
    await db.put("memories", memory);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.delete("memories", id);
  },

  /**
   * Strict same-scope title lookup, used by `saveMemory`'s duplicate check.
   * Only matches a memory whose `spaceId` is *exactly* the requested scope —
   * a global "X" does not block creating a space-scoped "X" (and vice versa).
   */
  async findByTitleInExactScope(
    title: string,
    spaceId: string | null,
  ): Promise<Memory | undefined> {
    if (!title) return undefined;
    const db = await getDb();
    const all = await db.getAll("memories");
    const lower = title.toLowerCase();
    return all.find(
      (m) => m.spaceId === spaceId && m.title.toLowerCase() === lower,
    );
  },

  /**
   * Find every memory matching `title` (case-insensitive) within the
   * agent's current visibility set: globals when no space is active, or
   * globals + active-space memories when one is. Used by `recallMemory`,
   * `updateMemory`, and `deleteMemory` to enumerate ambiguous matches —
   * collisions are surfaced to the model rather than silently picking one.
   *
   * Returns matches in a stable order: space-scoped first (when present),
   * global second. The agent doesn't have to depend on the order, but the
   * stability avoids flaky test diffs.
   */
  async findAllByTitle(
    title: string,
    activeSpaceId: string | null,
  ): Promise<Memory[]> {
    if (!title) return [];
    const all = await this.list(activeSpaceId);
    const lower = title.toLowerCase();
    const matches = all.filter((m) => m.title.toLowerCase() === lower);
    // Sort: space-scoped first, then globals. activeSpaceId === null path
    // can only contain globals, so sort is a no-op there.
    matches.sort((a, b) => {
      if (a.spaceId === b.spaceId) return 0;
      if (a.spaceId === null) return 1; // global goes after
      return -1;
    });
    return matches;
  },

  /**
   * Test/debug helper. Reset the in-memory db handle so a fresh
   * `indexedDB` (e.g. fake-indexeddb in tests) is opened on next call.
   */
  _resetForTests(): void {
    dbPromise = null;
  },
};
