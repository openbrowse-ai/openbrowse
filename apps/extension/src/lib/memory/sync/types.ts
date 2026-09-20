// src/lib/memory/sync/types.ts
//
// Contracts for memory sync. Deliberately free of OPFS / chrome / File System
// Access imports so `engine.ts` can be unit-tested against in-memory fakes.
//
// See docs/superpowers/specs/2026-09-07-memory-sync-design.md.

/**
 * Metadata-only view of a remote file: what can be known without reading it.
 *
 * `listFiles` returns these rather than hashed entries so the engine can apply
 * `SyncLimits` *before* any content is read. Hashing the whole tree up front
 * would mean a hostile or merely huge vault had already been decoded into memory
 * by the time the caps rejected it, which makes the caps decorative.
 */
export interface RemoteFileStat {
  path: string;
  /** Byte length from `File.size` — no decode required. */
  size: number;
  updated: number;
}

/** A file as seen by either side of the sync. */
export interface FileEntry {
  /** Path relative to the sync root, e.g. `memory/garry-tan.md`. */
  path: string;
  /** SHA-256 hex of the file's UTF-8 contents. */
  sha256: string;
  size: number;
  /** Last-modified epoch ms. Used only to break a same-day conflict tie. */
  updated: number;
}

/**
 * Record of a deletion. This is the only fact that cannot be re-derived by
 * walking the vault, which is why each one is its own file in the vault (no
 * write contention, no lost update) rather than an entry in the manifest.
 */
export interface Tombstone {
  path: string;
  deletedAt: number;
  profileId: string;
  profileLabel: string;
}

/**
 * `path -> sha256` as of the last successful sync, stored per profile and
 * locally (never in the vault). This is what makes three-way reconciliation
 * possible: without it there is no way to tell "I created this file" apart from
 * "the other profile deleted it".
 */
export type Baseline = Record<string, string>;

/** The profile's own identity, used to attribute tombstones and conflicts. */
export interface SyncProfile {
  id: string;
  label: string;
}

/** The local `memory/**` tree (OPFS in production). */
export interface LocalTreePort {
  list(): Promise<FileEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type TransportStatus =
  /** No vault linked yet. */
  | "unset"
  /** Linked and usable right now. */
  | "granted"
  /** Handle stored but permission needs a user gesture to restore. */
  | "lapsed"
  /** Permission explicitly refused. */
  | "denied"
  /** Folder was moved, renamed, or deleted. */
  | "missing";

/**
 * The remote side. Implemented by `directory-transport.ts` today; the interface
 * exists so `chrome.storage.sync` or the loopback broker can be added later
 * without touching reconciliation.
 */
export interface MemorySyncTransport {
  readonly id: string;
  status(): Promise<TransportStatus>;
  /** Metadata only. Content is read later, and only for entries that pass the limits. */
  listFiles(): Promise<RemoteFileStat[]>;
  /** SHA-256 of one file's contents. Called only for accepted entries. */
  hashFile(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listTombstones(): Promise<Tombstone[]>;
  putTombstone(t: Tombstone): Promise<void>;
  dropTombstone(path: string): Promise<void>;
  archiveConflict(path: string, content: string, at: number): Promise<void>;
  /** Archived losing copies, newest first. */
  listConflicts(): Promise<ConflictEntry[]>;
  readConflict(archivedPath: string): Promise<string>;
  dropConflict(archivedPath: string): Promise<void>;
  /** Best-effort cross-profile advisory lock. Correctness must not depend on it. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Why a remote file was refused. Surfaced in the UI rather than swallowed. */
export type SkipReason =
  | "unsafe-path"
  | "not-global-memory"
  | "too-large"
  | "too-many-files";

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface ConflictRecord {
  path: string;
  /** Which side won. */
  winner: "local" | "remote";
  /** Where the losing copy was archived, relative to the vault root. */
  archivedAt: string;
}

/** An archived losing copy, as listed back out of the vault. */
export interface ConflictEntry {
  /** Vault-relative path of the archive file. */
  archivedPath: string;
  /** The memory path it is a copy of, e.g. `memory/garry-tan.md`. */
  path: string;
  /** When the conflict was resolved. */
  at: number;
}

export interface SyncResult {
  ranAt: number;
  pulled: string[];
  pushed: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  /** Paths where a concurrent delete lost to an edit. */
  resurrected: string[];
  conflicts: ConflictRecord[];
  skipped: SkippedFile[];
  error?: string;
}

export interface SyncLimits {
  /** Cap on remote files considered in one pass. */
  maxFiles: number;
  /** Cap on a single remote file's byte size. */
  maxBytes: number;
  /** Tombstones older than this are garbage-collected. */
  tombstoneTtlMs: number;
}

export const DEFAULT_SYNC_LIMITS: SyncLimits = {
  maxFiles: 1_000,
  maxBytes: 1_024 * 1_024,
  tombstoneTtlMs: 90 * 24 * 60 * 60 * 1_000,
};

export function emptyResult(ranAt: number): SyncResult {
  return {
    ranAt,
    pulled: [],
    pushed: [],
    deletedLocal: [],
    deletedRemote: [],
    resurrected: [],
    conflicts: [],
    skipped: [],
  };
}

/** Compact shape persisted in `Settings.memorySync.lastResult` for the status line. */
export interface SyncResultSummary {
  ranAt: number;
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: number;
  resurrected: number;
  skipped: number;
  error?: string;
}

export function summarize(result: SyncResult): SyncResultSummary {
  return {
    ranAt: result.ranAt,
    pulled: result.pulled.length,
    pushed: result.pushed.length,
    deleted: result.deletedLocal.length + result.deletedRemote.length,
    conflicts: result.conflicts.length,
    resurrected: result.resurrected.length,
    skipped: result.skipped.length,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Folder name we suggest for the vault, under the user's Documents directory.
 *
 * Why a visible folder in Documents rather than a dotfolder in `$HOME` (the
 * `~/.claude` / `~/.codex` / `~/.openbrowse` pattern):
 *
 *   - **Dotfolders are hidden in the OS file picker.** The user must pick this
 *     folder by hand in every profile. On macOS and Windows a leading dot means
 *     it isn't shown at all without a keyboard trick — disqualifying for the one
 *     thing this folder has to be: pickable.
 *   - **`startIn` cannot open `$HOME`.** The well-known values are `desktop`,
 *     `documents`, `downloads`, `music`, `pictures`, `videos`. Documents is the
 *     closest thing to "where the user's own files live".
 *   - **The convention splits by audience, not by tool.** Dotfolders hold machine
 *     state the user isn't meant to browse — exactly what `~/.openbrowse/`
 *     already holds for the MCP broker. User-facing knowledge content goes
 *     somewhere visible: basic-memory defaults to `~/basic-memory`, and Obsidian
 *     vaults live wherever the user can find them. This vault is meant to be
 *     opened in Obsidian, committed to git, and read by a human.
 *   - On macOS with iCloud Drive's Desktop & Documents option enabled,
 *     `~/Documents` is already replicated, so cross-machine sync comes free.
 *
 * The root is `OpenBrowse`, not `OpenBrowse Memory`: the vault root already
 * *contains* `memory/` (naming the root "memory" would read as
 * `…/memory/memory/`), and this leaves room for more to sync later. Any folder
 * works — this is only what the UI suggests.
 */
export const SUGGESTED_VAULT_FOLDER = "OpenBrowse";

/**
 * `showDirectoryPicker`'s `id`, which makes Chrome reopen the picker where the
 * user last left it.
 *
 * Must be ASCII alphanumeric or `_`, 32 characters or fewer — a hyphen makes the
 * call throw `TypeError`. Paired with `startIn: "documents"`, a remembered
 * directory wins when one exists and Documents is used otherwise: helpful the
 * first time, unobtrusive afterwards.
 */
export const VAULT_PICKER_ID = "openbrowse_memory";
