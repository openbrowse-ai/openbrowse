// src/lib/memory/sync/controller.ts
//
// Orchestration around `reconcile()`: vault linking, the permission state
// machine, mutual exclusion, and persistence of profile identity + baseline.
//
// This must run in an extension **document** (Settings, side panel, home), never
// the service worker: restoring a lapsed File System Access grant needs
// `requestPermission()` under a user gesture, and Chromium will not prompt from
// a worker with no open window (crbug.com/1359786). The SW can only *ask* for a
// sync via `requestMemorySync()`; whichever surface is open performs it.

import { storage } from "../../storage";
import type { MemorySyncSettings } from "../../types";
import { memorySyncDb } from "./db";
import {
    createDirectoryTransport,
    ensureVaultMeta,
    readStatus,
    requestVaultPermission,
} from "./directory-transport";
import { reconcile } from "./engine";
import { createOpfsMemoryTree } from "./local-tree";
import {
    emptyResult,
    summarize,
    type ConflictEntry,
    type MemorySyncTransport,
    type SyncResult,
    type TransportStatus,
} from "./types";

/** Web Locks name; scoped per storage partition, i.e. per Chrome profile. */
const LOCK_NAME = "openbrowse:memory-sync";

export { MEMORY_SYNC_REQUEST, requestMemorySync } from "./messages";

export interface MemorySyncState {
  status: TransportStatus;
  settings: MemorySyncSettings | null;
  syncing: boolean;
}

/**
 * Guards against two triggers in the same document racing. Cross-document races
 * within a profile are handled by Web Locks and cross-profile races by the
 * vault's advisory lock; this is the cheap first line.
 */
let inFlight: Promise<SyncResult> | null = null;

/** Suppresses the `vfs:change` trigger while sync performs its own writes. */
let selfWriting = false;

export function isSyncing(): boolean {
  return inFlight !== null;
}

export function isSelfWriting(): boolean {
  return selfWriting;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function defaultSyncSettings(): MemorySyncSettings {
  return {
    enabled: false,
    profileId: crypto.randomUUID(),
    profileLabel: "",
    vaultId: null,
    vaultName: null,
    lastSyncAt: null,
  };
}

/** Read sync settings, minting this profile's identity on first access. */
export async function getSyncSettings(): Promise<MemorySyncSettings> {
  const settings = await storage.getSettings();
  if (settings.memorySync?.profileId) return settings.memorySync;
  const next = { ...defaultSyncSettings(), ...settings.memorySync };
  // Persist immediately so the id is stable from here on — a regenerated
  // profileId would orphan this profile's tombstones.
  await patchSyncSettings(next);
  return next;
}

export async function patchSyncSettings(
  patch: Partial<MemorySyncSettings>,
): Promise<MemorySyncSettings> {
  let result!: MemorySyncSettings;
  await storage.updateSettings((current) => {
    const base = current.memorySync ?? defaultSyncSettings();
    result = { ...base, ...patch };
    return { ...current, memorySync: result };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

/** Current transport status without prompting. Safe to call on mount. */
export async function getStatus(): Promise<TransportStatus> {
  const settings = await getSyncSettings();
  if (!settings.enabled) return "unset";
  const stored = await memorySyncDb.getHandle();
  if (!stored) return "unset";
  return readStatus(stored.handle);
}

/**
 * Prompt for a folder and link it. Must be called from a user gesture.
 *
 * Linking never deletes: the first pass has no baseline, so every path is
 * treated as new and the two trees are unioned.
 */
export async function linkVault(): Promise<{
  status: TransportStatus;
  settings: MemorySyncSettings;
}> {
  const picker = (
    globalThis as unknown as {
      showDirectoryPicker?: (opts?: {
        id?: string;
        mode?: "read" | "readwrite";
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) throw new Error("This browser cannot pick a folder.");

  const handle = await picker({ id: "openbrowse-memory", mode: "readwrite" });
  const status = await readStatus(handle);
  if (status !== "granted") {
    return { status, settings: await getSyncSettings() };
  }

  const meta = await ensureVaultMeta(handle);
  await memorySyncDb.putHandle(handle);

  const previous = await getSyncSettings();
  // Pointing at a different vault must start from a clean baseline; reusing the
  // old one would read the new vault's unknown files as our own deletions.
  if (previous.vaultId && previous.vaultId !== meta.vaultId) {
    await memorySyncDb.clearBaseline(previous.vaultId);
  }

  const settings = await patchSyncSettings({
    enabled: true,
    vaultId: meta.vaultId,
    vaultName: handle.name,
    profileLabel: previous.profileLabel || "",
  });
  return { status: "granted", settings };
}

/** Re-grant a lapsed permission. Must be called from a user gesture. */
export async function reconnectVault(): Promise<TransportStatus> {
  const stored = await memorySyncDb.getHandle();
  if (!stored) return "unset";
  return requestVaultPermission(stored.handle);
}

/**
 * Stop syncing. Drops the handle and baseline but never touches files — neither
 * the vault's nor OPFS's. Unlinking is not a delete.
 */
export async function unlinkVault(): Promise<void> {
  const settings = await getSyncSettings();
  if (settings.vaultId) await memorySyncDb.clearBaseline(settings.vaultId);
  await memorySyncDb.clearHandle();
  await patchSyncSettings({
    enabled: false,
    vaultId: null,
    vaultName: null,
    lastSyncAt: null,
    lastResult: undefined,
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncOptions {
  /**
   * When true, skip silently unless permission is currently granted. Used by the
   * opportunistic triggers so they never surface an error the user did not ask
   * for. The manual button passes false so problems are visible.
   */
  opportunistic?: boolean;
}

/**
 * Run one sync pass, or return an empty result when the vault is not usable.
 *
 * Concurrency has three layers, narrowest first: an in-process promise, a Web
 * Lock (per profile, across this profile's documents), and the vault's advisory
 * lock file (across profiles). Only the first two are reliable; reconciliation
 * is written to be correct without the third.
 */
export async function syncNow(opts: SyncOptions = {}): Promise<SyncResult> {
  if (inFlight) return inFlight;

  const run = (async (): Promise<SyncResult> => {
    const settings = await getSyncSettings();
    if (!settings.enabled || !settings.vaultId) return emptyResult(Date.now());

    const stored = await memorySyncDb.getHandle();
    if (!stored) return emptyResult(Date.now());

    const status = await readStatus(stored.handle);
    if (status !== "granted") {
      if (opts.opportunistic) return emptyResult(Date.now());
      return {
        ...emptyResult(Date.now()),
        error: statusMessage(status),
      };
    }

    const transport = createDirectoryTransport(stored.handle);
    const local = createOpfsMemoryTree();
    const baseline = await memorySyncDb.getBaseline(settings.vaultId);

    selfWriting = true;
    try {
      const outcome = await withWebLock(() =>
        transport.withLock(() =>
          reconcile({
            local,
            transport,
            baseline,
            profile: {
              id: settings.profileId,
              label: settings.profileLabel || "This profile",
            },
          }),
        ),
      );

      await memorySyncDb.putBaseline(settings.vaultId, outcome.baseline);
      await patchSyncSettings({
        lastSyncAt: outcome.result.ranAt,
        lastResult: summarize(outcome.result),
      });
      return outcome.result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failed: SyncResult = { ...emptyResult(Date.now()), error: message };
      await patchSyncSettings({ lastResult: summarize(failed) });
      return failed;
    } finally {
      selfWriting = false;
    }
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}

// ---------------------------------------------------------------------------
// Conflict archive
// ---------------------------------------------------------------------------

/** A usable transport, or null when the vault is unlinked or not currently granted. */
async function activeTransport(): Promise<MemorySyncTransport | null> {
  const settings = await getSyncSettings();
  if (!settings.enabled || !settings.vaultId) return null;
  const stored = await memorySyncDb.getHandle();
  if (!stored) return null;
  if ((await readStatus(stored.handle)) !== "granted") return null;
  return createDirectoryTransport(stored.handle);
}

export async function listConflicts(): Promise<ConflictEntry[]> {
  const transport = await activeTransport();
  if (!transport) return [];
  return transport.listConflicts();
}

/**
 * Bring an archived losing copy back as the live note. The restored content
 * lands in OPFS (reindexed on the way in), which makes it a local edit the next
 * sync pushes to the vault. The archive is dropped once restored.
 */
export async function restoreConflict(entry: ConflictEntry): Promise<void> {
  const transport = await activeTransport();
  if (!transport) throw new Error(statusMessage(await getStatus()));
  const content = await transport.readConflict(entry.archivedPath);
  selfWriting = true;
  try {
    await createOpfsMemoryTree().write(entry.path, content);
  } finally {
    selfWriting = false;
  }
  await transport.dropConflict(entry.archivedPath);
}

export async function dismissConflict(archivedPath: string): Promise<void> {
  const transport = await activeTransport();
  if (!transport) throw new Error(statusMessage(await getStatus()));
  await transport.dropConflict(archivedPath);
}

function withWebLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (
    navigator as unknown as {
      locks?: { request<R>(name: string, cb: () => Promise<R>): Promise<R> };
    }
  ).locks;
  if (!locks) return fn();
  return locks.request(LOCK_NAME, fn);
}

export function statusMessage(status: TransportStatus): string {
  switch (status) {
    case "lapsed":
      return "Reconnect the folder to resume syncing.";
    case "denied":
      return "Folder access was denied.";
    case "missing":
      return "The sync folder was moved or deleted.";
    case "unset":
      return "No sync folder linked.";
    case "granted":
      return "";
  }
}
