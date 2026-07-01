import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "openbrowse-mcp-audit";
const DB_VERSION = 1;
const STORE = "entries";

export interface AuditDbEntry {
  seq: number;
  ts: number;
  clientId: string;
  hostName: string;
  method: string;
  durationMs: number;
  outcome: "ok" | "error" | "denied" | "rate_limited";
  errorCode?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

async function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: "seq" });
          s.createIndex("by-ts", "ts");
          s.createIndex("by-client", "clientId");
        }
      },
    });
  }
  return dbPromise;
}

export const auditDb = {
  async append(entry: AuditDbEntry): Promise<void> {
    const d = await db();
    await d.put(STORE, entry);
  },

  /** List entries newest first, optionally filtered by clientId, capped to last 30 days. */
  async list(opts: { clientId?: string; limit?: number } = {}): Promise<AuditDbEntry[]> {
    const d = await db();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const all = (await d.getAll(STORE)) as AuditDbEntry[];
    return all
      .filter((e) => e.ts >= cutoff)
      .filter((e) => !opts.clientId || e.clientId === opts.clientId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, opts.limit ?? 200);
  },

  async clearOlderThan(cutoffMs: number): Promise<void> {
    const d = await db();
    const tx = d.transaction(STORE, "readwrite");
    const index = tx.objectStore(STORE).index("by-ts");
    let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoffMs));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  },

  /** Test helper: reset the cached promise so re-opens hit a fresh DB. */
  _resetForTests(): void {
    dbPromise = null;
  },
};
