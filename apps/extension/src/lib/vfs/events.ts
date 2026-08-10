// src/lib/vfs/events.ts
//
// Change notifications for the OPFS-backed virtual filesystem.
//
// OPFS is per-origin, so every extension context (settings page, sidepanel,
// offscreen document, MV3 service worker) reads and writes the *same* files.
// A plain in-process `EventTarget` therefore only tells half the story: an
// agent run authoring `memory/**` from the service worker would leave a
// settings tab's memory browser rendering whatever it walked on mount.
//
// So `emitVfsChange` does two things: dispatch locally, and mirror onto a
// `BroadcastChannel` that every other same-origin extension context re-emits
// on its own `vfsEvents`. Subscribers only ever deal with `vfsEvents` and stay
// unaware of which context performed the write.

export interface VfsChangeDetail {
  path: string;
}

export const vfsEvents = new EventTarget();

const CHANNEL_NAME = "openbrowse:vfs-change";

function dispatchLocal(path: string) {
  vfsEvents.dispatchEvent(
    new CustomEvent<VfsChangeDetail>("vfs:change", { detail: { path } }),
  );
}

/**
 * Whether this context should participate in cross-context broadcast.
 *
 * True in extension pages (`window`) and in the MV3 service worker
 * (`ServiceWorkerGlobalScope`). False in the Node test environment, which
 * exposes a `BroadcastChannel` global that would hold the event loop open for
 * no benefit — unit tests assert on the local dispatch.
 */
function canBroadcast(): boolean {
  if (typeof BroadcastChannel === "undefined") return false;
  if (typeof window !== "undefined") return true;
  const g = globalThis as { ServiceWorkerGlobalScope?: unknown };
  return typeof g.ServiceWorkerGlobalScope !== "undefined";
}

function createChannel(): BroadcastChannel | null {
  if (!canBroadcast()) return null;
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    // A BroadcastChannel never echoes to the posting context, so re-emitting
    // received messages locally cannot loop.
    ch.onmessage = (event: MessageEvent<VfsChangeDetail>) => {
      const path = event.data?.path;
      if (typeof path === "string") dispatchLocal(path);
    };
    return ch;
  } catch {
    return null;
  }
}

const channel: BroadcastChannel | null = createChannel();

export function emitVfsChange(path: string) {
  dispatchLocal(path);
  try {
    channel?.postMessage({ path } satisfies VfsChangeDetail);
  } catch {
    // Channel closed (context tearing down) — the local dispatch already
    // happened, and other contexts refresh on their next catch-up pass.
  }
}
