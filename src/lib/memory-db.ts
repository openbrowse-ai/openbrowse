import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface Memory {
  id: string;
  type: "user" | "feedback" | "site" | "reference";
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

  async findByTitle(title: string, spaceId: string | null): Promise<Memory | undefined> {
    if (!title) return undefined;
    const all = await this.list(spaceId);
    const lower = title.toLowerCase();
    return all.find((m) => m.title.toLowerCase() === lower);
  },
};
