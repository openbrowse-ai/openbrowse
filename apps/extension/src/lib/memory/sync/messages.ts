// src/lib/memory/sync/messages.ts
//
// The one piece of sync the service worker is allowed to touch.
//
// Sync itself must run in a document: restoring a lapsed File System Access
// grant needs `requestPermission()` under a user gesture, and Chromium will not
// prompt from a worker with no open window (crbug.com/1359786). The SW can only
// ask.
//
// Kept in its own module so importing it does not drag the transport, the OPFS
// port, and the memory index into the service worker bundle.

/** Runtime message asking any open surface to run a sync pass. */
export const MEMORY_SYNC_REQUEST = "memory-sync:request";

export interface MemorySyncRequestMessage {
  type: typeof MEMORY_SYNC_REQUEST;
}

/**
 * Best-effort nudge to open surfaces. With no surface listening this resolves to
 * a rejected sendMessage (no receiver), which is swallowed — the next surface to
 * mount syncs on its own, so a dropped nudge only ever costs latency.
 */
export function requestMemorySync(): void {
  try {
    chrome.runtime
      .sendMessage({ type: MEMORY_SYNC_REQUEST } satisfies MemorySyncRequestMessage)
      .catch(() => {});
  } catch {
    // Messaging unavailable in this context.
  }
}
