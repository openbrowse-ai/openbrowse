// src/lib/memory-db.ts
//
// Memory v2 — derived IndexedDB index (Layer 2).
//
// The source of truth for memories is now markdown files in OPFS (see
// `lib/memory/format.ts` and `lib/memory/store.ts`). This module is the
// *rebuildable cache* that makes retrieval fast: it stores parsed frontmatter
// + a searchable body copy per file, plus a `[[wikilink]]` link table for O(1)
// backlink lookup.
//
// Nothing here is authoritative — if the index is ever missing or corrupt,
// `memoryStore.reconcile()` walks OPFS and rebuilds it.
//
// The legacy v1 store (`memories`, keyed by a UUID `id`, holding the full
// memory `content`) is retained read-only for one release so the one-time v1→v2
// migration can read it. See `lib/memory/migrate.ts`.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MemoryScope, MemoryType } from "./memory/format";

/** Legacy v1 record shape. Retained only so migration can read old rows. */
export interface LegacyMemory {
  id: string;
  type: MemoryType;
  title: string;
  description: string;
  content: string;
  domain: string | null;
  spaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A row in the derived index. `id` is the OPFS file path (stable + unique per
 * scope), which doubles as the primary key. `content` is a cached copy of the
 * compiled-truth block; `body` is the full searchable text.
 */
export interface MemoryIndexRow {
  /** OPFS file path — the primary key. */
  id: string;
  slug: string;
  scope: MemoryScope;
  spaceId: string | null;
  type: MemoryType;
  title: string;
  description: string;
  domain: string | null;
  aliases: string[];
  /** Compiled-truth block (for display, diffs, duplicate checks). */
  content: string;
  /**
   * Timeline entries, kept verbatim so `rowToDoc` can reconstruct the document
   * without slicing them back out of `body` by offset. Optional because rows
   * indexed before this field existed won't have it (a `reconcile()` refills
   * them from disk).
   */
  timeline?: string[];
  /** Full searchable text (title + description + aliases + truth + timeline). */
  body: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

/** A directed `[[wikilink]]` edge, extracted from a source memory's body. */
export interface MemoryLinkRow {
  /** `${sourceId}\u0000${targetSlug}` — dedupes edges per source. */
  id: string;
  sourceId: string;
  sourceSlug: string;
  sourceSpaceId: string | null;
  targetSlug: string;
}

const DB_NAME = "openbrowse-memory";
const DB_VERSION = 2;

interface MemoryDB extends DBSchema {
  // Legacy v1 store — kept for the migration read + one-release safety net.
  memories: {
    key: string;
    value: LegacyMemory;
    indexes: {
      "by-space": string;
      "by-type": string;
      "by-domain": string;
    };
  };
  memoryIndex: {
    key: string;
    value: MemoryIndexRow;
    indexes: {
      /**
       * Space-scoped rows only. IndexedDB doesn't index null keys, so global
       * rows (`spaceId: null`) are absent from this index by design — queries
       * that need globals scan `allRows()` / `visibleRows()` instead.
       */
      "by-space": string;
      "by-slug": string;
    };
  };
  links: {
    key: string;
    value: MemoryLinkRow;
    indexes: {
      "by-source": string;
      "by-target": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<MemoryDB>> | null = null;

function getDb(): Promise<IDBPDatabase<MemoryDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MemoryDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          // Fresh install: still create the legacy store so a later migration
          // pass has a consistent (empty) source to read.
          const legacy = db.createObjectStore("memories", { keyPath: "id" });
          legacy.createIndex("by-space", "spaceId");
          legacy.createIndex("by-type", "type");
          legacy.createIndex("by-domain", "domain");
        }
        if (oldVersion < 2) {
          const idx = db.createObjectStore("memoryIndex", { keyPath: "id" });
          idx.createIndex("by-space", "spaceId");
          idx.createIndex("by-slug", "slug");

          const links = db.createObjectStore("links", { keyPath: "id" });
          links.createIndex("by-source", "sourceId");
          links.createIndex("by-target", "targetSlug");
        }
      },
    });
  }
  return dbPromise;
}

function linkKey(sourceId: string, targetSlug: string): string {
  return `${sourceId}\u0000${targetSlug}`;
}

export const memoryIndexDb = {
  // ---- index rows ----

  async putRow(row: MemoryIndexRow): Promise<void> {
    const db = await getDb();
    await db.put("memoryIndex", row);
  },

  async getRow(id: string): Promise<MemoryIndexRow | undefined> {
    const db = await getDb();
    return db.get("memoryIndex", id);
  },

  async deleteRow(id: string): Promise<void> {
    const db = await getDb();
    await db.delete("memoryIndex", id);
  },

  async allRows(): Promise<MemoryIndexRow[]> {
    const db = await getDb();
    return db.getAll("memoryIndex");
  },

  /** Rows visible from `activeSpaceId`: globals + that space's rows. */
  async visibleRows(activeSpaceId: string | null): Promise<MemoryIndexRow[]> {
    const all = await this.allRows();
    return all.filter((r) => r.spaceId === null || r.spaceId === activeSpaceId);
  },

  // ---- links ----

  /**
   * Replace the outgoing links for `sourceId` with `targetSlugs`. Old edges
   * from this source are removed first so a re-save can't leave stale edges.
   */
  async setLinks(
    sourceId: string,
    sourceSlug: string,
    sourceSpaceId: string | null,
    targetSlugs: string[],
  ): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("links", "readwrite");
    const store = tx.objectStore("links");
    const existing = await store.index("by-source").getAllKeys(sourceId);
    for (const key of existing) await store.delete(key);
    for (const targetSlug of targetSlugs) {
      const row: MemoryLinkRow = {
        id: linkKey(sourceId, targetSlug),
        sourceId,
        sourceSlug,
        sourceSpaceId,
        targetSlug,
      };
      await store.put(row);
    }
    await tx.done;
  },

  async deleteLinksFrom(sourceId: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("links", "readwrite");
    const store = tx.objectStore("links");
    const keys = await store.index("by-source").getAllKeys(sourceId);
    for (const key of keys) await store.delete(key);
    await tx.done;
  },

  async allLinks(): Promise<MemoryLinkRow[]> {
    const db = await getDb();
    return db.getAll("links");
  },

  /** Edges pointing *at* `targetSlug` (its backlinks). */
  async linksByTarget(targetSlug: string): Promise<MemoryLinkRow[]> {
    const db = await getDb();
    return db.getAllFromIndex("links", "by-target", targetSlug);
  },

  /** Edges originating *from* `sourceId`. */
  async linksBySource(sourceId: string): Promise<MemoryLinkRow[]> {
    const db = await getDb();
    return db.getAllFromIndex("links", "by-source", sourceId);
  },

  /** Wipe the derived index (rows + links). Used before a full reindex. */
  async clear(): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["memoryIndex", "links"], "readwrite");
    await tx.objectStore("memoryIndex").clear();
    await tx.objectStore("links").clear();
    await tx.done;
  },

  // ---- legacy (v1) read access, for migration ----

  async readLegacyRows(): Promise<LegacyMemory[]> {
    const db = await getDb();
    // The store always exists (created in the v0→v1 upgrade hop above).
    return db.getAll("memories");
  },

  /** Test helper: seed legacy v1 rows so the migration pass has input. */
  async _seedLegacyForTests(rows: LegacyMemory[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("memories", "readwrite");
    for (const row of rows) await tx.objectStore("memories").put(row);
    await tx.done;
  },

  /**
   * Test/debug helper. Reset the in-memory db handle so a fresh `indexedDB`
   * (e.g. fake-indexeddb in tests) is opened on next call.
   */
  _resetForTests(): void {
    dbPromise = null;
  },
};
