/**
 * Cross-context handoff for an artifact "Fix with OpenBrowse" request.
 *
 * The artifact tab writes the (possibly large) fix prompt here; the side panel
 * reads and clears it on mount. We use `chrome.storage.local` because it is
 * shared across all extension contexts — unlike `chrome.storage.session`,
 * which is partitioned so a regular extension tab (the artifact) and the side
 * panel do NOT see each other's values. Read-and-clear plus a short TTL keep
 * the slightly-more-durable `local` storage from leaking stale requests.
 *
 * The prompt (stack traces + console output) is too large for the
 * `chrome.sidePanel.setOptions({ path })` querystring, which silently drops it.
 */

const STORAGE_KEY = "openbrowse:pending-fix-request";

export interface ArtifactFixRequest {
  artifactId: string;
  prompt: string;
  autoSubmit: boolean;
  requestedAt: number;
}

/** Requests older than this are considered stale and discarded on read. */
export const FIX_REQUEST_TTL_MS = 60_000;

/** Stash a fix request (overwrites any prior one — latest wins). */
export async function setPendingFixRequest(req: ArtifactFixRequest): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: req });
}

/**
 * Return the pending request and clear it. Returns null when none is queued or
 * the queued one is older than `FIX_REQUEST_TTL_MS` (relative to `now`).
 */
export async function takePendingFixRequest(now = Date.now()): Promise<ArtifactFixRequest | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const req = stored[STORAGE_KEY] as ArtifactFixRequest | undefined;
  if (req) await chrome.storage.local.remove(STORAGE_KEY);
  if (!req) return null;
  if (now - req.requestedAt > FIX_REQUEST_TTL_MS) return null;
  return req;
}

/**
 * Like `takePendingFixRequest`, but polls briefly to absorb the cold-open race:
 * the artifact tab fires the (async) write and then opens the side panel, which
 * may mount and read the slot before the write has resolved. Retries a few
 * times with a short delay before giving up.
 */
export async function pollPendingFixRequest(
  attempts = 10,
  delayMs = 100,
): Promise<ArtifactFixRequest | null> {
  for (let i = 0; i < attempts; i++) {
    const req = await takePendingFixRequest();
    if (req) return req;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}
