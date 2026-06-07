import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * IndexedDB-backed per-conversation run-ownership lock.
 *
 * Exactly one context (a home page acting as "host") may own a running
 * conversation's agent loop at a time. Ownership is the authoritative
 * single-writer guard that prevents multiple open tabs (home tabs, side
 * panels, popups, duplicate home tabs) from each independently driving
 * the same conversation.
 *
 * This is the atomic counterpart to `queue-db`'s `flushClaims` mutex,
 * generalized for the whole run rather than a single queue-head flush:
 *
 *   - `claimOwnership` runs in a single IndexedDB `readwrite` transaction
 *     so two contexts racing to claim the same conversation can't both
 *     win (unlike a `chrome.storage.session` check-then-set, which has a
 *     TOCTOU window).
 *   - The owner must `renewOwnership` (heartbeat) periodically. A host
 *     that closes/crashes mid-run stops heartbeating; after
 *     {@link STALE_OWNER_MS} its claim is reclaimable by another context.
 *   - `releaseOwnership` is the clean exit at run end.
 *
 * The DB is separate from `chat-db` and `queue-db` so its schema can
 * evolve independently and a wipe never touches the transcript or queue.
 */

export type HostKind = "home";

export interface RunOwnership {
  conversationId: string;
  ownerToken: string;
  hostKind: HostKind;
  claimedAt: number;
  heartbeatAt: number;
}

interface OwnershipDB extends DBSchema {
  ownership: {
    key: string; // conversationId
    value: RunOwnership;
  };
}

const DB_NAME = "openbrowse-run-ownership";
const DB_VERSION = 1;

/**
 * How long an owner's heartbeat may lapse before another context may
 * reclaim ownership. Must comfortably exceed the renew cadence
 * ({@link HEARTBEAT_MS}) so a live-but-busy host isn't reclaimed out
 * from under itself.
 */
export const STALE_OWNER_MS = 30_000;

/** Recommended heartbeat cadence for owners. */
export const HEARTBEAT_MS = 10_000;

let dbPromise: Promise<IDBPDatabase<OwnershipDB>> | null = null;

function getDb(): Promise<IDBPDatabase<OwnershipDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OwnershipDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("ownership")) {
          db.createObjectStore("ownership", { keyPath: "conversationId" });
        }
      },
    });
  }
  return dbPromise;
}

function isStale(row: RunOwnership, now: number): boolean {
  return now - row.heartbeatAt >= STALE_OWNER_MS;
}

export const runOwnership = {
  /**
   * Atomically claim (or re-claim) ownership of `conversationId` for
   * `ownerToken`.
   *
   * Returns `true` if this token now owns the conversation. Returns
   * `false` if a *different*, non-stale owner already holds it.
   *
   * Idempotent for the current owner: calling again with the same token
   * succeeds and refreshes the heartbeat. A stale owner (no heartbeat
   * within {@link STALE_OWNER_MS}) is reaped and replaced here so a
   * crashed host can't lock a conversation forever.
   */
  async claimOwnership(
    conversationId: string,
    ownerToken: string,
    hostKind: HostKind = "home",
    now: number = Date.now(),
  ): Promise<boolean> {
    const db = await getDb();
    const tx = db.transaction("ownership", "readwrite");
    const store = tx.objectStore("ownership");
    const existing = await store.get(conversationId);

    if (
      existing &&
      existing.ownerToken !== ownerToken &&
      !isStale(existing, now)
    ) {
      // A different, live owner holds it.
      await tx.done;
      return false;
    }

    const claimedAt =
      existing && existing.ownerToken === ownerToken
        ? existing.claimedAt
        : now;

    await store.put({
      conversationId,
      ownerToken,
      hostKind,
      claimedAt,
      heartbeatAt: now,
    });
    await tx.done;
    return true;
  },

  /**
   * Refresh the heartbeat for an owner. Returns `true` if this token
   * still owns the conversation (heartbeat refreshed), `false` if it has
   * lost ownership (someone else claimed it, e.g. after a stale reap).
   */
  async renewOwnership(
    conversationId: string,
    ownerToken: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    const db = await getDb();
    const tx = db.transaction("ownership", "readwrite");
    const store = tx.objectStore("ownership");
    const existing = await store.get(conversationId);
    if (!existing || existing.ownerToken !== ownerToken) {
      await tx.done;
      return false;
    }
    await store.put({ ...existing, heartbeatAt: now });
    await tx.done;
    return true;
  },

  /**
   * Release ownership held by `ownerToken`. No-op if the row is gone or
   * owned by someone else (we never delete another owner's claim).
   */
  async releaseOwnership(
    conversationId: string,
    ownerToken: string,
  ): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("ownership", "readwrite");
    const store = tx.objectStore("ownership");
    const existing = await store.get(conversationId);
    if (existing && existing.ownerToken === ownerToken) {
      await store.delete(conversationId);
    }
    await tx.done;
  },

  /**
   * Read the current owner row, or `null` if unowned. A stale owner is
   * reported as `null` (it's reclaimable), so callers can treat the
   * conversation as idle.
   */
  async getOwner(
    conversationId: string,
    now: number = Date.now(),
  ): Promise<RunOwnership | null> {
    const db = await getDb();
    const row = await db.get("ownership", conversationId);
    if (!row) return null;
    if (isStale(row, now)) return null;
    return row;
  },

  /**
   * True if `ownerToken` currently holds a live claim on the
   * conversation.
   */
  async isOwner(
    conversationId: string,
    ownerToken: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    const owner = await runOwnership.getOwner(conversationId, now);
    return owner?.ownerToken === ownerToken;
  },

  /** Test/debug helper. Drop the cached db handle. */
  _resetForTests(): void {
    dbPromise = null;
  },
};
