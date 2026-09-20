// src/hooks/useMemorySyncDriver.ts
//
// The memory-sync trigger loop, with no UI attached.
//
// Sync has to run in a document: restoring a lapsed File System Access grant
// needs `requestPermission()` under a user gesture, and Chromium will not prompt
// from a worker with no open window (crbug.com/1359786). The service worker can
// only broadcast a request, so *something long-lived and visible* has to be
// listening — otherwise the broadcast lands on nobody and memory written during a
// run never reaches the vault.
//
// This is mounted in every surface a chat can run in:
//
//   sidepanel/App.tsx    → `sidepanel` and `popup` origins (same entrypoint)
//   _shared/HomeApp.tsx  → `home` and `newtab` origins (same shell)
//
// which covers four of the five `RunOrigin` values. The fifth, `mcp`, is an
// external host driving the agent with no OpenBrowse page open; nothing can sync
// on its behalf until a surface opens. That gap is inherent to this transport's
// permission model.
//
// Every pass here is opportunistic: it skips silently when the grant has lapsed,
// so a user who has not reconnected is never nagged and never shown an error they
// did not ask for. `syncNow` also enforces a shared minimum interval, so N open
// new-tab pages do not turn tab switching into N sync attempts.

import { useCallback, useEffect, useRef } from "react";

import {
  MEMORY_SYNC_REQUEST,
  POST_RUN_FLOOR_MS,
  isSelfWriting,
  syncNow,
} from "@/lib/memory/sync/controller";
import { vfsEvents, type VfsChangeDetail } from "@/lib/vfs/events";

/** Coalescing window for `vfs:change`-driven syncs. */
export const VFS_DEBOUNCE_MS = 3_000;

/**
 * Whether a `vfs:change` path should schedule a sync.
 *
 * Global memory only in v1, so a space-scoped write is not our business. Matches
 * the directory prefix rather than `.md` files, because a recursive directory
 * delete emits the directory's own path.
 */
export function qualifiesForSync(path: unknown): boolean {
  return typeof path === "string" && path.startsWith("memory/");
}

export interface MemorySyncDriverOptions {
  /**
   * Called after every pass. The Settings panel uses this to re-read status and
   * conflicts; headless mounts leave it off.
   */
  onAfterPass?: () => void | Promise<void>;
}

/**
 * Install the automatic sync triggers for as long as the component is mounted.
 *
 * Mounting this in several surfaces at once is expected and safe: `syncNow`
 * coalesces within a document, a Web Lock serializes across this profile's
 * documents, and reconciliation is idempotent, so a redundant pass writes
 * nothing.
 */
export function useMemorySyncDriver(
  options: MemorySyncDriverOptions = {},
): void {
  const { onAfterPass } = options;

  const mounted = useRef(true);
  const vfsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept in a ref so a caller passing an inline closure doesn't reinstall every
  // listener on each render.
  const afterPass = useRef(onAfterPass);
  afterPass.current = onAfterPass;

  const run = useCallback(async (floorMs?: number) => {
    if (!mounted.current) return;
    try {
      await syncNow({
        opportunistic: true,
        ...(floorMs === undefined ? {} : { floorMs }),
      });
    } catch {
      // Opportunistic passes are silent by contract. `syncNow` already reports
      // failures through `Settings.memorySync.lastResult` for the UI to show.
    } finally {
      if (mounted.current) await afterPass.current?.();
    }
  }, []);

  // Mount, plus every return to the foreground — a background surface can be
  // throttled or frozen, so becoming visible again is the moment to catch up.
  useEffect(() => {
    mounted.current = true;
    void run();

    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run]);

  // The service worker asking any open surface to sync after an agent run.
  useEffect(() => {
    const listener = (msg: unknown) => {
      // A run just wrote memory, so this pass must not be suppressed by an
      // unrelated pass from a few seconds ago. The short floor still collapses the
      // broadcast across every open surface into one pass.
      if ((msg as { type?: string })?.type === MEMORY_SYNC_REQUEST) {
        void run(POST_RUN_FLOOR_MS);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [run]);

  // Local memory writes, debounced.
  //
  // Sync's own writes emit `vfs:change` too, so they are filtered explicitly
  // rather than left to the floor. The floor is a rate limiter for a different
  // concern; leaning on it to suppress echoes would couple echo-safety to a tuning
  // constant, and quietly break if that constant were ever lowered. Idempotency
  // remains the actual guarantee — this just avoids scheduling pointless work.
  useEffect(() => {
    const onChange = (event: Event) => {
      if (isSelfWriting()) return;
      const path = (event as CustomEvent<VfsChangeDetail>).detail?.path;
      if (!qualifiesForSync(path)) return;
      if (vfsTimer.current) clearTimeout(vfsTimer.current);
      vfsTimer.current = setTimeout(() => void run(), VFS_DEBOUNCE_MS);
    };
    vfsEvents.addEventListener("vfs:change", onChange);
    return () => {
      vfsEvents.removeEventListener("vfs:change", onChange);
      if (vfsTimer.current) clearTimeout(vfsTimer.current);
    };
  }, [run]);
}
