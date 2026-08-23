/**
 * Storage durability for the extension origin.
 *
 * Chrome's quota system stores every origin's IndexedDB / OPFS / Cache
 * data in a bucket that is "best-effort" by default. Best-effort buckets
 * are evicted — in their entirety, all storage APIs at once — when the
 * device comes under storage pressure, least-recently-used origin first.
 * For OpenBrowse that means conversations, agent-authored memory, Space
 * uploads and artifacts disappear together, with no recovery path,
 * because none of it is mirrored to a server.
 *
 * Two independent mitigations, because neither is sufficient alone:
 *
 *   1. The `unlimitedStorage` manifest permission. Per Chrome's own
 *      extension storage docs this "exempts extensions from both quota
 *      restrictions and eviction", and it is the load-bearing one. See
 *      the comment on the permission in `wxt.config.ts`.
 *   2. `navigator.storage.persist()`, below. Belt and braces: it asks
 *      the browser to flip the bucket's mode to "persistent", which the
 *      Storage Standard says the user agent may not clear without user
 *      involvement.
 *
 * Caveats worth knowing before trusting this file:
 *
 *   - `persist()` is `[Exposed=Window]` in the Storage Standard, so it
 *     does NOT exist on `WorkerNavigator`. It cannot be called from the
 *     MV3 service worker; only `persisted()` and `estimate()` can. That
 *     is why the entry point here runs from the document surfaces
 *     (newtab / home / sidepanel / settings) rather than at SW boot.
 *   - Chrome is reported to keep extension buckets non-persistent even
 *     when the request "succeeds" (DevTools shows `Is persistent: No`).
 *     So a `false` result is expected, not a bug — we log it rather than
 *     treating it as an error, and `unlimitedStorage` is what actually
 *     protects the data.
 *   - Sandboxed surfaces (the artifact runtime) have an opaque origin,
 *     for which obtaining a storage shelf fails and `persist()` rejects
 *     with a `TypeError`. Do not call this from there.
 */

/** Outcome of a durability check. All fields are best-effort. */
export type StoragePersistence = {
  /** Whether the origin's default bucket is in "persistent" mode. */
  persisted: boolean;
  /** Whether we actually issued a `persist()` request this call. */
  requested: boolean;
  /** Bytes currently attributed to this origin, or null if unavailable. */
  usage: number | null;
  /** Bytes this origin is allowed, or null if unavailable. */
  quota: number | null;
};

/**
 * Warn when `estimate()` reports fewer than this many bytes of quota left
 * for this origin. Exceeding the quota makes IndexedDB / OPFS / Cache
 * writes fail with `QuotaExceededError`, so this is a heads-up about that
 * one specific failure.
 *
 * It is NOT a disk-pressure signal and does not predict eviction.
 * Chromium sizes an origin quota from *total* disk size (~60% of it), and
 * the Storage Standard requires that the quota "must not be a function of
 * the available storage space on the device" - `estimate()` deliberately
 * hides free space, because exposing it is a fingerprinting vector.
 * Eviction keys on actual device free space and on browser-wide usage,
 * neither of which is observable here. So low headroom means "this origin
 * is near its own cap", not "the disk is nearly full".
 */
const LOW_HEADROOM_BYTES = 256 * 1024 * 1024;

/**
 * Memoized so the N components mounting on a single surface share one
 * request. Scoped to this JS realm, so each document load re-checks —
 * which is what we want: a transient failure shouldn't be cached for the
 * lifetime of the profile.
 */
let inflight: Promise<StoragePersistence> | null = null;

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GiB" : mb.toFixed(1) + " MiB";
}

/**
 * Read this origin's usage/quota. Safe in both window and worker
 * contexts; resolves to nulls rather than throwing when the platform
 * refuses (opaque origin, storage disabled, internal error).
 */
export async function readStorageEstimate(): Promise<{
  usage: number | null;
  quota: number | null;
}> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
      return { usage: null, quota: null };
    }
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? null, quota: quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

/**
 * Whether this origin's data is exempt from eviction. Safe in both
 * window and worker contexts — unlike `persist()`, `persisted()` is
 * exposed to workers.
 */
export async function isStoragePersisted(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persisted) {
      return false;
    }
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Request eviction-exempt storage for this origin, once per document.
 *
 * Idempotent, never throws, and never blocks startup — callers should
 * fire-and-forget with `void`. Skips the request when the bucket is
 * already persistent so we don't re-ask on every surface open.
 *
 * Must run in a Window context; no-ops (returning `requested: false`)
 * in the service worker, where `persist()` is not exposed.
 */
export function ensurePersistedStorage(): Promise<StoragePersistence> {
  inflight ??= runEnsure();
  return inflight;
}

async function runEnsure(): Promise<StoragePersistence> {
  const { usage, quota } = await readStorageEstimate();

  if (quota != null && usage != null && quota - usage < LOW_HEADROOM_BYTES) {
    console.warn(
      "[storage] low quota headroom: " +
        formatBytes(usage) +
        " used of " +
        formatBytes(quota) +
        " reported by estimate(). Writes will fail with " +
        "QuotaExceededError once this origin exceeds its quota. This is " +
        "remaining quota, not free disk space.",
    );
  }

  if (await isStoragePersisted()) {
    return { persisted: true, requested: false, usage, quota };
  }

  // `persist()` is Window-only. In the service worker the property is
  // simply absent, so this doubles as the worker guard.
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage?.persist !== "function"
  ) {
    return { persisted: false, requested: false, usage, quota };
  }

  try {
    const persisted = await navigator.storage.persist();
    if (!persisted) {
      // Expected on Chrome for extension origins. `unlimitedStorage` is
      // the real protection; this is only the second layer.
      console.info(
        "[storage] persist() declined; relying on the unlimitedStorage " +
          "permission for eviction exemption.",
      );
    }
    return { persisted, requested: true, usage, quota };
  } catch (err) {
    // Opaque origin (sandboxed page) or storage disabled by the user.
    console.warn("[storage] persist() failed:", err);
    return { persisted: false, requested: true, usage, quota };
  }
}

/** Test-only: drop the memoized request so each case starts clean. */
export function _resetForTests(): void {
  inflight = null;
}
