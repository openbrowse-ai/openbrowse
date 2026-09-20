// src/hooks/useMemorySync.ts
//
// Drives opportunistic memory sync from an extension surface, and exposes the
// state the Settings UI renders.
//
// The automatic triggers live in `useMemorySyncDriver`, which is also mounted
// headlessly in the side panel and the home/new-tab shell so a run that writes
// memory gets synced wherever the chat happened. This hook composes that driver
// with the state the panel renders, and adds the explicit user actions.
//
// Only the explicit actions report errors. Automatic passes skip silently when
// the folder grant has lapsed, so a user who has not reconnected is never nagged.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  dismissConflict,
  getStatus,
  getSyncSettings,
  getVaultSuggestion,
  linkVault,
  listConflicts,
  patchSyncSettings,
  reconnectVault,
  restoreConflict,
  syncNow,
  unlinkVault,
} from "@/lib/memory/sync/controller";
import type { VaultHint } from "@/lib/memory/sync/discovery";
import type { ConflictEntry, TransportStatus } from "@/lib/memory/sync/types";
import type { MemorySyncSettings } from "@/lib/types";
import { useMemorySyncDriver } from "./useMemorySyncDriver";

export interface UseMemorySync {
  /**
   * False until the first state read resolves. Without this the UI cannot tell
   * "no folder linked" from "not loaded yet", and a user who linked months ago
   * gets a flash of the onboarding pitch on every mount.
   */
  ready: boolean;
  status: TransportStatus;
  settings: MemorySyncSettings | null;
  /**
   * True only during an *explicit* sync. Opportunistic passes are meant to be
   * invisible, and showing a spinner for them would replace the actionable
   * "Reconnect the folder" message with "Syncing…" on every visibility change —
   * flickering away the one thing the user needs to act on.
   */
  syncing: boolean;
  conflicts: ConflictEntry[];
  /**
   * A vault another of this user's profiles already linked, when this profile
   * hasn't. Lets the UI name the folder to pick rather than leaving the user to
   * remember it. Null when nothing is advertised — including the common case of
   * profiles signed into different Google accounts.
   */
  suggestion: VaultHint | null;
  /**
   * Set when the user linked a folder that is *not* the one another profile
   * advertised — the likeliest setup mistake, and otherwise invisible until they
   * notice memory never converging. Cleared by the next explicit action.
   */
  mismatch: boolean;
  /** Error from the last *explicit* action, cleared on the next one. */
  error: string | null;
  link: () => Promise<void>;
  reconnect: () => Promise<void>;
  unlink: () => Promise<void>;
  sync: () => Promise<void>;
  setLabel: (label: string) => Promise<void>;
  restore: (entry: ConflictEntry) => Promise<void>;
  dismiss: (archivedPath: string) => Promise<void>;
}

export function useMemorySync(): UseMemorySync {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<TransportStatus>("unset");
  const [settings, setSettings] = useState<MemorySyncSettings | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [suggestion, setSuggestion] = useState<VaultHint | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Survives re-renders without re-triggering effects.
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const [nextStatus, nextSettings] = await Promise.all([
      getStatus(),
      getSyncSettings(),
    ]);
    if (!mounted.current) return;
    setStatus(nextStatus);
    setSettings(nextSettings);
    setReady(true);
    if (nextStatus === "granted") {
      const list = await listConflicts().catch(() => []);
      if (mounted.current) setConflicts(list);
    } else {
      setConflicts([]);
    }
    // Best-effort: no Chrome Sync, or profiles on different accounts, simply
    // means no suggestion and the folder flow behaves as it always did.
    const hint = await getVaultSuggestion().catch(() => null);
    if (mounted.current) setSuggestion(hint);
  }, []);

  /**
   * An explicit, user-initiated pass. Automatic passes go through the driver and
   * never surface errors; this one is the only path that does, because it is the
   * only one the user asked for.
   */
  const run = useCallback(async () => {
    if (!mounted.current) return;
    setSyncing(true);
    setError(null);
    try {
      const result = await syncNow();
      if (result.error) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setSyncing(false);
      await refresh();
    }
  }, [refresh]);

  // Automatic triggers: mount, refocus, post-run broadcast, debounced memory
  // writes. Shared with the headless mounts in the side panel and home shell.
  useMemorySyncDriver({ onAfterPass: refresh });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const wrap = useCallback(
    async (fn: () => Promise<unknown>, thenSync: boolean) => {
      setError(null);
      try {
        await fn();
        if (thenSync) await run();
        else await refresh();
      } catch (e) {
        // An aborted folder picker is the user changing their mind, not an error.
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
        await refresh();
      }
    },
    [refresh, run],
  );

  return {
    ready,
    status,
    settings,
    syncing,
    conflicts,
    suggestion,
    mismatch,
    error,
    link: () =>
      wrap(async () => {
        setMismatch(false);
        const result = await linkVault();
        setMismatch(result.joinedSuggestion === "mismatched");
      }, true),
    reconnect: () => wrap(reconnectVault, true),
    unlink: () =>
      wrap(async () => {
        setMismatch(false);
        await unlinkVault();
      }, false),
    sync: () => run(),
    setLabel: (label: string) =>
      wrap(() => patchSyncSettings({ profileLabel: label }), false),
    restore: (entry: ConflictEntry) => wrap(() => restoreConflict(entry), true),
    dismiss: (archivedPath: string) =>
      wrap(() => dismissConflict(archivedPath), false),
  };
}
