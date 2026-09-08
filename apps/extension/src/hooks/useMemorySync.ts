// src/hooks/useMemorySync.ts
//
// Drives opportunistic memory sync from an extension surface, and exposes the
// state the Settings UI renders.
//
// Sync lives in a document rather than the service worker because restoring a
// lapsed File System Access grant needs a user gesture (crbug.com/1359786). The
// consequence is that sync is a checkpoint operation: it happens when a surface
// is around, not continuously in the background.
//
// Triggers:
//   - mount, and every time the document becomes visible again
//   - a `memory-sync:request` message (the service worker after an agent run)
//   - a debounced `vfs:change` under `memory/**`
//   - the user pressing "Sync now"
//
// The first three are opportunistic: they skip silently when permission has
// lapsed, so the user is never nagged and never sees an error they did not ask
// for. Only the explicit button reports problems.

import { useCallback, useEffect, useRef, useState } from "react";

import {
    MEMORY_SYNC_REQUEST,
    dismissConflict,
    getStatus,
    getSyncSettings,
    isSelfWriting,
    linkVault,
    listConflicts,
    patchSyncSettings,
    reconnectVault,
    restoreConflict,
    syncNow,
    unlinkVault,
} from "@/lib/memory/sync/controller";
import type { ConflictEntry, TransportStatus } from "@/lib/memory/sync/types";
import type { MemorySyncSettings } from "@/lib/types";
import { vfsEvents, type VfsChangeDetail } from "@/lib/vfs/events";

/** Coalescing window for `vfs:change`-driven syncs. */
const VFS_DEBOUNCE_MS = 3_000;

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
  const [error, setError] = useState<string | null>(null);

  // Survives re-renders without re-triggering effects.
  const mounted = useRef(true);
  const vfsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, []);

  /** One sync pass. `opportunistic` suppresses error surfacing. */
  const run = useCallback(
    async (opportunistic: boolean) => {
      if (!mounted.current) return;
      if (!opportunistic) {
        setSyncing(true);
        setError(null);
      }
      try {
        const result = await syncNow({ opportunistic });
        if (!opportunistic && result.error) setError(result.error);
      } catch (e) {
        if (!opportunistic) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (mounted.current && !opportunistic) setSyncing(false);
        await refresh();
      }
    },
    [refresh],
  );

  // Mount + visibility. A background surface can be frozen or throttled, so
  // becoming visible again is the moment to catch up.
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      await refresh();
      await run(true);
    })();

    const onVisible = () => {
      if (document.visibilityState === "visible") void run(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, run]);

  // The service worker asking any open surface to sync after an agent run.
  useEffect(() => {
    const listener = (msg: unknown) => {
      if ((msg as { type?: string })?.type === MEMORY_SYNC_REQUEST) {
        void run(true);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [run]);

  // Debounced local writes. Sync's own writes emit `vfs:change` too, so they are
  // filtered by `isSelfWriting()`. That is an optimization, not the safety net:
  // reconciliation is idempotent, so a self-triggered pass would find nothing to
  // do and terminate anyway.
  useEffect(() => {
    const onChange = (event: Event) => {
      if (isSelfWriting()) return;
      const path = (event as CustomEvent<VfsChangeDetail>).detail?.path;
      // Global memory only in v1; a space-scoped write is not our business.
      if (typeof path !== "string" || !path.startsWith("memory/")) return;
      if (vfsTimer.current) clearTimeout(vfsTimer.current);
      vfsTimer.current = setTimeout(() => void run(true), VFS_DEBOUNCE_MS);
    };
    vfsEvents.addEventListener("vfs:change", onChange);
    return () => {
      vfsEvents.removeEventListener("vfs:change", onChange);
      if (vfsTimer.current) clearTimeout(vfsTimer.current);
    };
  }, [run]);

  const wrap = useCallback(
    async (fn: () => Promise<unknown>, thenSync: boolean) => {
      setError(null);
      try {
        await fn();
        if (thenSync) await run(false);
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
    error,
    link: () => wrap(linkVault, true),
    reconnect: () => wrap(reconnectVault, true),
    unlink: () => wrap(unlinkVault, false),
    sync: () => run(false),
    setLabel: (label: string) =>
      wrap(() => patchSyncSettings({ profileLabel: label }), false),
    restore: (entry: ConflictEntry) => wrap(() => restoreConflict(entry), true),
    dismiss: (archivedPath: string) =>
      wrap(() => dismissConflict(archivedPath), false),
  };
}
