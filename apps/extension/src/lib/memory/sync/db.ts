// src/lib/memory/sync/db.ts
//
// Local, per-profile sync state.
//
// Two things live here and neither can live anywhere else:
//
//   - **The directory handle.** `FileSystemDirectoryHandle` is
//     structured-cloneable, so IndexedDB can persist it; `chrome.storage` is
//     JSON-only and would silently store `{}`.
//   - **The baseline** (`path -> sha256` at last sync). It is unbounded in size
//     and `Settings` is read on every service-worker boot, so it does not belong
//     in the settings blob.
//
// Both are deliberately profile-local: they describe what *this* profile last
// saw, so putting them in the vault would create write contention between
// profiles for no benefit.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Baseline } from "./types";

export interface StoredVaultHandle {
  id: "vault";
  handle: FileSystemDirectoryHandle;
  /** Folder name, for display before permission is re-granted. */
  name: string;
  linkedAt: number;
}

interface StoredBaseline {
  /** Vault id, so relinking a different folder starts from a clean baseline. */
  id: string;
  baseline: Baseline;
  updatedAt: number;
}

const DB_NAME = "openbrowse-memory-sync";
const DB_VERSION = 1;

interface MemorySyncDB extends DBSchema {
  handles: { key: string; value: StoredVaultHandle };
  baselines: { key: string; value: StoredBaseline };
}

let dbPromise: Promise<IDBPDatabase<MemorySyncDB>> | null = null;

function getDb(): Promise<IDBPDatabase<MemorySyncDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MemorySyncDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("handles", { keyPath: "id" });
          db.createObjectStore("baselines", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export const memorySyncDb = {
  async putHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await getDb();
    await db.put("handles", {
      id: "vault",
      handle,
      name: handle.name,
      linkedAt: Date.now(),
    });
  },

  async getHandle(): Promise<StoredVaultHandle | undefined> {
    const db = await getDb();
    return db.get("handles", "vault");
  },

  async clearHandle(): Promise<void> {
    const db = await getDb();
    await db.delete("handles", "vault");
  },

  async getBaseline(vaultId: string): Promise<Baseline> {
    const db = await getDb();
    const row = await db.get("baselines", vaultId);
    return row?.baseline ?? {};
  },

  async putBaseline(vaultId: string, baseline: Baseline): Promise<void> {
    const db = await getDb();
    await db.put("baselines", { id: vaultId, baseline, updatedAt: Date.now() });
  },

  async clearBaseline(vaultId: string): Promise<void> {
    const db = await getDb();
    await db.delete("baselines", vaultId);
  },

  /** Test helper: drop the cached connection so a fresh `indexedDB` is opened. */
  _resetForTests(): void {
    dbPromise = null;
  },
};
