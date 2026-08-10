// src/lib/memory/migrate.ts
//
// One-time v1 → v2 memory migration.
//
// v1 stored memories as IndexedDB rows (`{ id, title, content, ... }`) with
// exact-title recall. v2 (file-first) stores each as an OPFS markdown file the
// agent authors directly, plus a derived index. This pass reads the legacy rows
// and rewrites them as **flat** v2 files (no type-based foldering — the store is
// unopinionated; the agent can reorganize later), then rebuilds the index by
// reconciling from disk.
//
// Idempotent + guarded by a `memorySchemaVersion` flag in chrome.storage.local
// so it runs at most once per upgrade. Even without the flag it is safe (file
// writes are keyed by path, and a colliding slug picks the next free name), but
// the flag avoids repeat work at every SW boot.
//
// The legacy `memories` store is left in place (read-only) for one release as a
// safety net; a later release can drop it.

import { memoryIndexDb } from "../memory-db";
import { OPFS } from "../vfs/opfs";
import {
  memoryDirPath,
  serializeMemory,
  slugify,
  today,
  type MemoryDoc,
} from "./format";
import { memoryStore } from "./store";

const FLAG_KEY = "memorySchemaVersion";
const CURRENT_VERSION = 2;

async function getFlag(): Promise<number> {
  try {
    const res = await chrome.storage.local.get(FLAG_KEY);
    const v = res[FLAG_KEY];
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

async function setFlag(version: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [FLAG_KEY]: version });
  } catch {
    // Best effort; a failed flag write just means we retry next boot.
  }
}

/** First free `memory/<slug>[-n].md` path in the row's scope. */
async function freeFilePath(
  slug: string,
  spaceId: string | null,
): Promise<string> {
  const dir = memoryDirPath(spaceId);
  let candidate = `${dir}/${slug}.md`;
  if (!(await OPFS.exists(candidate).catch(() => false))) return candidate;
  for (let i = 2; i < 10_000; i++) {
    candidate = `${dir}/${slug}-${i}.md`;
    if (!(await OPFS.exists(candidate).catch(() => false))) return candidate;
  }
  return `${dir}/${slug}-${Date.now()}.md`;
}

/**
 * True when this row's file was already written by an earlier (partly failed)
 * migration pass. The serialized text is fully derived from the legacy row, so
 * an identical file at one of the candidate slugs means "already migrated" —
 * which lets a retry skip it instead of writing a duplicate note.
 */
async function alreadyMigrated(
  slug: string,
  spaceId: string | null,
  text: string,
): Promise<boolean> {
  const dir = memoryDirPath(spaceId);
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? `${dir}/${slug}.md` : `${dir}/${slug}-${i}.md`;
    if (!(await OPFS.exists(candidate).catch(() => false))) return false;
    const existing = await OPFS.readFile(candidate).catch(() => null);
    if (existing === text) return true;
  }
  return false;
}

/**
 * Run the v1 → v2 migration if it hasn't run yet. Returns the number of
 * memories migrated (0 when already up to date or nothing to migrate).
 */
export async function migrateMemoryV2(
  knownSpaceIds: string[] = [],
): Promise<number> {
  if ((await getFlag()) >= CURRENT_VERSION) return 0;

  let migrated = 0;
  let failed = 0;
  // Spaces referenced by legacy rows. Files are written for these scopes, so
  // reconcile has to walk them too — otherwise a row belonging to a space the
  // caller didn't list (deleted, or simply not loaded yet) gets a file on disk
  // that nothing ever indexes.
  const migratedSpaceIds = new Set<string>();
  try {
    const legacy = await memoryIndexDb.readLegacyRows();
    for (const row of legacy) {
      try {
        const slug = slugify(row.title || row.id);
        const created = today(row.createdAt);
        const updated = today(row.updatedAt);
        const doc: MemoryDoc = {
          title: row.title || slug,
          description: row.description || "",
          // `type` is dropped from the v2 model; serialize a neutral default so
          // the file still round-trips. The agent/UI no longer surface it.
          type: "reference",
          domain: row.domain,
          aliases: [],
          created,
          updated,
          truth: row.content || "",
          timeline: [
            `${created} — Migrated from v1 memory. [Source: migration]`,
          ],
        };
        if (row.spaceId) migratedSpaceIds.add(row.spaceId);
        const text = serializeMemory(doc);
        if (await alreadyMigrated(slug, row.spaceId, text)) continue;
        const path = await freeFilePath(slug, row.spaceId);
        await OPFS.writeFile(path, text);
        migrated++;
      } catch (e) {
        failed++;
        console.warn("[memory] migration: failed to migrate row", row.id, e);
      }
    }
  } catch (e) {
    console.warn("[memory] migration: could not read legacy rows", e);
    // Don't set the flag — retry on next boot.
    return migrated;
  }

  // Build the derived index from the freshly written files (source of truth).
  try {
    await memoryStore.reconcile([
      ...new Set([...knownSpaceIds, ...migratedSpaceIds]),
    ]);
  } catch (e) {
    console.warn("[memory] migration: reconcile failed", e);
  }

  // Only close the door when every row landed. A row that failed to write is
  // still only in the legacy store, so leaving the flag unset is what gives it
  // another chance next boot; `alreadyMigrated` keeps that retry from
  // duplicating the rows that did succeed.
  if (failed === 0) await setFlag(CURRENT_VERSION);
  return migrated;
}
