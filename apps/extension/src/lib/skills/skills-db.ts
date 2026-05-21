import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { InstalledSkill, SpaceSkillConfig } from "./types";

interface SkillsDB extends DBSchema {
  skills: {
    key: string;
    value: InstalledSkill;
  };
  spaceConfig: {
    key: [string, string];
    value: SpaceSkillConfig;
    indexes: {
      "by-space": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<SkillsDB>> | null = null;

function getDb(): Promise<IDBPDatabase<SkillsDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SkillsDB>("openbrowse-skills", 1, {
      upgrade(db) {
        db.createObjectStore("skills", { keyPath: "name" });
        const spaceStore = db.createObjectStore("spaceConfig", { keyPath: ["spaceId", "skillName"] });
        spaceStore.createIndex("by-space", "spaceId");
      },
    });
  }
  return dbPromise;
}

export const skillsDb = {
  async listAll(): Promise<InstalledSkill[]> {
    const db = await getDb();
    return db.getAll("skills");
  },

  async get(name: string): Promise<InstalledSkill | undefined> {
    const db = await getDb();
    return db.get("skills", name);
  },

  async save(skill: InstalledSkill): Promise<void> {
    const db = await getDb();
    await db.put("skills", skill);
  },

  async delete(name: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["skills", "spaceConfig"], "readwrite");
    await tx.objectStore("skills").delete(name);
    
    // Also cleanup space configs for this skill
    const spaceConfigs = await tx.objectStore("spaceConfig").getAll();
    for (const config of spaceConfigs) {
      if (config.skillName === name) {
        await tx.objectStore("spaceConfig").delete([config.spaceId, config.skillName]);
      }
    }
    
    await tx.done;
  },

  async listAllSpaceConfigs(): Promise<SpaceSkillConfig[]> {
    const db = await getDb();
    return db.getAll("spaceConfig");
  },

  async listSpaceConfigs(spaceId: string): Promise<SpaceSkillConfig[]> {
    const db = await getDb();
    return db.getAllFromIndex("spaceConfig", "by-space", spaceId);
  },

  async setSpaceState(spaceId: string, skillName: string, state: "allow" | "deny"): Promise<void> {
    const db = await getDb();
    await db.put("spaceConfig", { spaceId, skillName, state });
  },

  async getSpaceState(spaceId: string, skillName: string): Promise<SpaceSkillConfig | undefined> {
    const db = await getDb();
    return db.get("spaceConfig", [spaceId, skillName]);
  },
};
