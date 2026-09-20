// src/lib/memory/sync/directory-transport.ts
//
// `MemorySyncTransport` over a user-picked directory (the "vault"), via the File
// System Access API.
//
// Vault layout:
//
//   <vault>/memory/**                       mirrors OPFS memory/** 1:1
//   <vault>/.openbrowse/vault.json          { vaultId, schemaVersion, createdAt }
//   <vault>/.openbrowse/tombstones/*.json   one per deleted path
//   <vault>/.openbrowse/conflicts/<ts>/**   losing copies, outside memory/**
//   <vault>/.openbrowse/tmp/*               staging for atomic writes
//   <vault>/.openbrowse/lock                advisory cross-profile lock
//
// The `.openbrowse/` dotfolder keeps metadata invisible in Obsidian, and
// `isSafeRelPath` rejects dotted segments, so metadata can never be mistaken
// for a memory note.
//
// Permission caveat that shapes everything above this file: a stored handle's
// permission does not reliably survive a session, `requestPermission()` needs
// user activation, and Chromium will not prompt from a worker with no open
// window (crbug.com/1359786). So this transport reports `lapsed` rather than
// throwing, and only `reconnect()` — called from a click — can restore access.

import { timestampSlug } from "./engine";
import { sha256 } from "./hash";
import { isSafeRelPath } from "./paths";
import type {
  ConflictEntry,
  FileEntry,
  MemorySyncTransport,
  Tombstone,
  TransportStatus,
  RemoteFileStat,
} from "./types";

const META_DIR = ".openbrowse";
const MEMORY_DIR = "memory";
const VAULT_FILE = "vault.json";
const TOMBSTONE_DIR = "tombstones";
const CONFLICT_DIR = "conflicts";
const TMP_DIR = "tmp";
const LOCK_FILE = "lock";

/** A lock older than this is presumed abandoned and stolen. */
const LOCK_STALE_MS = 60_000;

export const VAULT_SCHEMA_VERSION = 1;

interface VaultMeta {
  vaultId: string;
  schemaVersion: number;
  createdAt: number;
}

/**
 * `queryPermission` / `requestPermission` are not in the TS DOM lib. Narrow
 * shims rather than blanket `any` casts.
 */
interface PermissionCapableHandle {
  queryPermission?: (d: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (d: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
}

/** `move()` ships in Chrome but is absent from the TS DOM lib. */
interface MovableFileHandle {
  move?: (dir: FileSystemDirectoryHandle, name?: string) => Promise<void>;
}

export function createDirectoryTransport(
  root: FileSystemDirectoryHandle,
): MemorySyncTransport {
  return {
    id: "directory",

    async status(): Promise<TransportStatus> {
      return readStatus(root);
    },

    async listFiles(): Promise<RemoteFileStat[]> {
      const memory = await getDir(root, [MEMORY_DIR], false);
      if (!memory) return [];
      const out: RemoteFileStat[] = [];
      for await (const relPath of walk(memory)) {
        const path = `${MEMORY_DIR}/${relPath}`;
        // Engine re-validates, but skipping junk here keeps the listing honest
        // and avoids statting files we would only reject.
        if (!isSafeRelPath(path)) continue;
        // `getFile()` hands back metadata without reading the bytes, so a huge or
        // hostile tree costs a stat per entry here and nothing more. Content is
        // read later, by `hashFile`, and only for entries the engine accepted.
        const stat = await statFileAt(memory, relPath);
        if (!stat) continue;
        out.push({ path, size: stat.size, updated: stat.lastModified });
      }
      return out;
    },

    async hashFile(path: string): Promise<string> {
      const segments = requireSafeSegments(path);
      const file = await readFileAtPath(root, segments);
      if (file === null) throw new Error(`vault: missing ${path}`);
      return sha256(file.content);
    },

    async readFile(path: string): Promise<string> {
      const segments = requireSafeSegments(path);
      const file = await readFileAtPath(root, segments);
      if (file === null) throw new Error(`vault: missing ${path}`);
      return file.content;
    },

    async writeFile(path: string, content: string): Promise<void> {
      const segments = requireSafeSegments(path);
      await writeAtomic(root, segments, content);
    },

    async deleteFile(path: string): Promise<void> {
      const segments = requireSafeSegments(path);
      const name = segments[segments.length - 1];
      const dir = await getDir(root, segments.slice(0, -1), false);
      if (!dir) return;
      try {
        await dir.removeEntry(name);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },

    async listTombstones(): Promise<Tombstone[]> {
      const dir = await getDir(root, [META_DIR, TOMBSTONE_DIR], false);
      if (!dir) return [];
      const out: Tombstone[] = [];
      for await (const name of walk(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = await readFileAt(dir, name);
        if (!file) continue;
        const parsed = parseTombstone(file.content);
        if (parsed) out.push(parsed);
      }
      return out;
    },

    async putTombstone(t: Tombstone): Promise<void> {
      const name = await tombstoneName(t.path);
      await writeAtomic(
        root,
        [META_DIR, TOMBSTONE_DIR, name],
        JSON.stringify(t),
      );
    },

    async dropTombstone(path: string): Promise<void> {
      const dir = await getDir(root, [META_DIR, TOMBSTONE_DIR], false);
      if (!dir) return;
      try {
        await dir.removeEntry(await tombstoneName(path));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },

    async archiveConflict(
      path: string,
      content: string,
      at: number,
    ): Promise<void> {
      const segments = requireSafeSegments(path);
      await writeAtomic(
        root,
        [META_DIR, CONFLICT_DIR, timestampSlug(at), ...segments],
        content,
      );
    },

    async listConflicts(): Promise<ConflictEntry[]> {
      const dir = await getDir(root, [META_DIR, CONFLICT_DIR], false);
      if (!dir) return [];
      const out: ConflictEntry[] = [];
      for await (const relPath of walk(dir)) {
        // `<timestamp-slug>/<original/path>`
        const slash = relPath.indexOf("/");
        if (slash <= 0) continue;
        const slug = relPath.slice(0, slash);
        const path = relPath.slice(slash + 1);
        out.push({
          archivedPath: `${META_DIR}/${CONFLICT_DIR}/${relPath}`,
          path,
          at: parseTimestampSlug(slug),
        });
      }
      return out.sort((a, b) => b.at - a.at);
    },

    async readConflict(archivedPath: string): Promise<string> {
      const segments = requireConflictSegments(archivedPath);
      const file = await readFileAtPath(root, segments);
      if (file === null) throw new Error(`vault: missing ${archivedPath}`);
      return file.content;
    },

    async dropConflict(archivedPath: string): Promise<void> {
      const segments = requireConflictSegments(archivedPath);
      const name = segments[segments.length - 1];
      const dir = await getDir(root, segments.slice(0, -1), false);
      if (!dir) return;
      try {
        await dir.removeEntry(name);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      const acquired = await acquireLock(root);
      try {
        return await fn();
      } finally {
        if (acquired) await releaseLock(root);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Permission + identity
// ---------------------------------------------------------------------------

export async function readStatus(
  root: FileSystemDirectoryHandle | null,
): Promise<TransportStatus> {
  if (!root) return "unset";
  const capable = root as unknown as PermissionCapableHandle;
  let state: PermissionState = "granted";
  if (capable.queryPermission) {
    try {
      state = await capable.queryPermission({ mode: "readwrite" });
    } catch {
      // Treat an unusable handle as needing a reconnect rather than crashing.
      return "lapsed";
    }
  }
  if (state === "denied") return "denied";
  if (state === "prompt") return "lapsed";

  // Permission is granted, but the folder may have been moved or deleted.
  try {
    // Any read against the handle surfaces a vanished directory.
    const iterator = (
      root as unknown as { entries(): AsyncIterableIterator<unknown> }
    ).entries();
    await iterator.next();
    return "granted";
  } catch (e) {
    if (isNotFound(e)) return "missing";
    if (isNotAllowed(e)) return "lapsed";
    return "missing";
  }
}

/**
 * Re-request permission. Must be called from a user gesture; without activation
 * `requestPermission()` throws, which is exactly why the UI gates this behind a
 * "Reconnect folder" button.
 */
export async function requestVaultPermission(
  root: FileSystemDirectoryHandle,
): Promise<TransportStatus> {
  const capable = root as unknown as PermissionCapableHandle;
  if (!capable.requestPermission) return readStatus(root);
  try {
    const state = await capable.requestPermission({ mode: "readwrite" });
    if (state === "denied") return "denied";
    if (state === "prompt") return "lapsed";
    return readStatus(root);
  } catch {
    return "lapsed";
  }
}

/**
 * Read the vault's identity, creating it on first link. The id lets a profile
 * notice it has been pointed at a *different* folder and start from a clean
 * baseline instead of misreading unknown files as deletions.
 */
export async function ensureVaultMeta(
  root: FileSystemDirectoryHandle,
): Promise<VaultMeta> {
  const existing = await readFileAtPath(root, [META_DIR, VAULT_FILE]);
  if (existing) {
    try {
      const parsed = JSON.parse(existing.content) as Partial<VaultMeta>;
      if (typeof parsed.vaultId === "string" && parsed.vaultId) {
        return {
          vaultId: parsed.vaultId,
          schemaVersion:
            typeof parsed.schemaVersion === "number"
              ? parsed.schemaVersion
              : VAULT_SCHEMA_VERSION,
          createdAt:
            typeof parsed.createdAt === "number"
              ? parsed.createdAt
              : Date.now(),
        };
      }
    } catch {
      // Corrupt vault.json: fall through and rewrite it. Losing the id costs one
      // full re-merge (which never deletes), not data.
    }
  }
  const meta: VaultMeta = {
    vaultId: crypto.randomUUID(),
    schemaVersion: VAULT_SCHEMA_VERSION,
    createdAt: Date.now(),
  };
  await writeAtomic(
    root,
    [META_DIR, VAULT_FILE],
    JSON.stringify(meta, null, 2),
  );
  return meta;
}

// ---------------------------------------------------------------------------
// Advisory cross-profile lock
// ---------------------------------------------------------------------------

/**
 * Best-effort only: the File System Access API has no atomic exclusive create,
 * so two profiles can both believe they hold the lock. Reconciliation is safe
 * regardless — per-file hashing means the worst outcome of a lost race is an
 * extra entry in the conflict archive.
 */
async function acquireLock(root: FileSystemDirectoryHandle): Promise<boolean> {
  const existing = await readFileAtPath(root, [META_DIR, LOCK_FILE]);
  if (existing) {
    try {
      const held = JSON.parse(existing.content) as { acquiredAt?: number };
      const age = Date.now() - (held.acquiredAt ?? 0);
      if (age < LOCK_STALE_MS) return false;
    } catch {
      // Unparseable lock: treat as stale and steal it.
    }
  }
  await writeAtomic(
    root,
    [META_DIR, LOCK_FILE],
    JSON.stringify({ acquiredAt: Date.now() }),
  );
  return true;
}

async function releaseLock(root: FileSystemDirectoryHandle): Promise<void> {
  const dir = await getDir(root, [META_DIR], false);
  if (!dir) return;
  try {
    await dir.removeEntry(LOCK_FILE);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function requireSafeSegments(path: string): string[] {
  if (!isSafeRelPath(path)) {
    throw new Error(`memory sync: unsafe vault path ${path}`);
  }
  return path.split("/");
}

/**
 * Validate a path into the conflict archive. `isSafeRelPath` rejects dotted
 * segments (which is what keeps `.openbrowse/` from ever looking like a memory
 * note), so archive paths are checked by requiring the exact expected prefix and
 * validating only the remainder.
 */
function requireConflictSegments(archivedPath: string): string[] {
  const prefix = `${META_DIR}/${CONFLICT_DIR}/`;
  if (!archivedPath.startsWith(prefix)) {
    throw new Error(`memory sync: not a conflict archive path ${archivedPath}`);
  }
  const rest = archivedPath.slice(prefix.length);
  if (!isSafeRelPath(rest)) {
    throw new Error(`memory sync: unsafe conflict path ${archivedPath}`);
  }
  return [META_DIR, CONFLICT_DIR, ...rest.split("/")];
}

/** Inverse of `timestampSlug`; falls back to 0 for an unrecognized folder. */
function parseTimestampSlug(slug: string): number {
  // `2026-09-07T14-22-01Z` → `2026-09-07T14:22:01Z`
  const iso = slug.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z$/,
    "$1$2:$3:$4Z",
  );
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Resolve a chain of directory names, optionally creating them. */
async function getDir(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  for (const segment of segments) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  return dir;
}

interface ReadFile {
  content: string;
  lastModified: number;
}

async function readFileAt(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<ReadFile | null> {
  const segments = relPath.split("/");
  const name = segments.pop();
  if (!name) return null;
  const parent = segments.length ? await getDir(dir, segments, false) : dir;
  if (!parent) return null;
  try {
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    return { content: await file.text(), lastModified: file.lastModified };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Size and mtime without reading the file. `getFile()` returns a `File` handle
 * whose metadata is available immediately; only `.text()`/`.arrayBuffer()` would
 * pull the bytes.
 */
async function statFileAt(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<{ size: number; lastModified: number } | null> {
  const segments = relPath.split("/");
  const name = segments.pop();
  if (!name) return null;
  const parent = segments.length ? await getDir(dir, segments, false) : dir;
  if (!parent) return null;
  try {
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    return { size: file.size, lastModified: file.lastModified };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function readFileAtPath(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<ReadFile | null> {
  return readFileAt(root, segments.join("/"));
}

/**
 * Write via a staging file in `.openbrowse/tmp`, then `move()` into place, so a
 * crash mid-write cannot leave a truncated note in the vault.
 *
 * `move()` is not in the TS DOM lib and its availability on local (non-OPFS)
 * handles is not guaranteed, so a direct write is the fallback. Correctness does
 * not depend on atomicity: a torn file is detected by hash mismatch on the next
 * pass and repaired.
 */
async function writeAtomic(
  root: FileSystemDirectoryHandle,
  segments: string[],
  content: string,
): Promise<void> {
  const name = segments[segments.length - 1];
  const destDir = await getDir(root, segments.slice(0, -1), true);
  if (!destDir) throw new Error("memory sync: cannot resolve vault directory");

  const tmpDir = await getDir(root, [META_DIR, TMP_DIR], true);
  if (tmpDir) {
    const tmpName = `${Date.now().toString(36)}-${crypto
      .randomUUID()
      .slice(0, 8)}.tmp`;
    try {
      const tmpHandle = await tmpDir.getFileHandle(tmpName, { create: true });
      await writeThrough(tmpHandle, content);
      const movable = tmpHandle as unknown as MovableFileHandle;
      if (movable.move) {
        await movable.move(destDir, name);
        return;
      }
      // No `move()`: fall through to a direct write and clean up the staging file.
      await tmpDir.removeEntry(tmpName).catch(() => {});
    } catch {
      await tmpDir.removeEntry(tmpName).catch(() => {});
    }
  }

  const handle = await destDir.getFileHandle(name, { create: true });
  await writeThrough(handle, content);
}

async function writeThrough(
  handle: FileSystemFileHandle,
  content: string,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

/** Yield every file path beneath `dir`, relative to it. */
async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix = "",
): AsyncGenerator<string> {
  const entries = (
    dir as unknown as {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }
  ).entries();
  for await (const [name, handle] of entries) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      yield* walk(handle as FileSystemDirectoryHandle, path);
    } else {
      yield path;
    }
  }
}

/** Tombstone filename: a hash of the path, so nesting never leaks into it. */
async function tombstoneName(path: string): Promise<string> {
  return `${await sha256(path)}.json`;
}

function parseTombstone(raw: string): Tombstone | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Tombstone>;
    if (typeof parsed.path !== "string" || !parsed.path) return null;
    return {
      path: parsed.path,
      deletedAt: typeof parsed.deletedAt === "number" ? parsed.deletedAt : 0,
      profileId: typeof parsed.profileId === "string" ? parsed.profileId : "",
      profileLabel:
        typeof parsed.profileLabel === "string" ? parsed.profileLabel : "",
    };
  } catch {
    return null;
  }
}

function isNotFound(e: unknown): boolean {
  return (e as { name?: string })?.name === "NotFoundError";
}

function isNotAllowed(e: unknown): boolean {
  return (e as { name?: string })?.name === "NotAllowedError";
}
