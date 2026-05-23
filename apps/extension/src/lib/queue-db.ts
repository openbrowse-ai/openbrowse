import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { QueuedMessage } from "./types";

/**
 * IndexedDB-backed message queue.
 *
 * Lives in a separate DB from `chat-db` so its schema can evolve
 * independently and so wiping the queue (e.g. for tests) doesn't risk
 * touching the conversation transcript.
 *
 * Both renderer contexts (sidepanel/home/popup) and the background
 * service worker open the same DB by name; the underlying IndexedDB is
 * shared at the extension origin. Mutations broadcast a
 * `QUEUE_CHANGED` runtime message so other open contexts can re-fetch.
 *
 * The `flushClaims` store implements the per-conversation flush mutex
 * (see `claimHead` / `releaseHead`). Only one panel may flush a given
 * conversation's head at a time; the row contains the queue id under
 * flush plus a timestamp so a stale claim (panel crash mid-flush) can
 * be reaped after a timeout.
 */

interface QueueDB extends DBSchema {
  queue: {
    key: string;
    value: QueuedMessage;
    indexes: {
      "by-conversation": string;
    };
  };
  flushClaims: {
    key: string; // conversationId
    value: {
      conversationId: string;
      queuedMessageId: string;
      claimedAt: number;
    };
  };
}

const DB_NAME = "openbrowse-queue";
const DB_VERSION = 1;
const STALE_CLAIM_MS = 60_000;

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null;

function getDb(): Promise<IDBPDatabase<QueueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<QueueDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("queue")) {
          const store = db.createObjectStore("queue", { keyPath: "id" });
          store.createIndex("by-conversation", "conversationId");
        }
        if (!db.objectStoreNames.contains("flushClaims")) {
          db.createObjectStore("flushClaims", { keyPath: "conversationId" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Broadcast a queue mutation to all extension contexts.
 *
 * `chrome.runtime.sendMessage` does NOT deliver back to its sender, so a
 * cross-context broadcast alone leaves the calling panel out of the
 * loop. We fix that by running an in-process pubsub first
 * ({@link subscribeQueueChange}), then doing the runtime broadcast for
 * sibling contexts. Local listeners fire synchronously so React state
 * updates land in the same tick as the mutation; failure to deliver
 * the cross-context message (no listener, non-extension test context)
 * is silent.
 */
type QueueChangeListener = (conversationId: string) => void;
const localListeners = new Set<QueueChangeListener>();

/**
 * Subscribe to queue mutations originating in the current JS context.
 * Returns an unsubscribe function. Listeners are called synchronously
 * after every successful mutation, before the cross-context runtime
 * broadcast goes out.
 *
 * Use this from the renderer hook so the panel that just called
 * `enqueue`/`remove`/`update`/`clear`/`releaseHead` actually sees the
 * resulting change in its own queue state. Cross-context delivery is
 * still handled by `chrome.runtime.onMessage` for `QUEUE_CHANGED`.
 */
export function subscribeQueueChange(
  listener: QueueChangeListener,
): () => void {
  localListeners.add(listener);
  return () => {
    localListeners.delete(listener);
  };
}

function notify(conversationId: string): void {
  for (const l of localListeners) {
    try {
      l(conversationId);
    } catch (err) {
      console.warn("[queue-db] local listener threw:", err);
    }
  }
  try {
    chrome.runtime
      ?.sendMessage?.({ type: "QUEUE_CHANGED", conversationId })
      ?.catch?.(() => {});
  } catch {
    /* non-extension context; ignore */
  }
}

export const queueDb = {
  async list(conversationId: string): Promise<QueuedMessage[]> {
    const db = await getDb();
    const items = await db.getAllFromIndex(
      "queue",
      "by-conversation",
      conversationId,
    );
    return items.sort((a, b) => a.createdAt - b.createdAt);
  },

  async enqueue(item: QueuedMessage): Promise<void> {
    const db = await getDb();
    await db.put("queue", item);
    notify(item.conversationId);
  },

  async update(
    id: string,
    patch: Partial<
      Pick<
        QueuedMessage,
        "text" | "mentionContext" | "attachmentBlock" | "visionFiles"
      >
    >,
  ): Promise<void> {
    const db = await getDb();
    const existing = await db.get("queue", id);
    if (!existing) return;
    const next: QueuedMessage = { ...existing, ...patch };
    await db.put("queue", next);
    notify(existing.conversationId);
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    const existing = await db.get("queue", id);
    if (!existing) return;
    await db.delete("queue", id);
    notify(existing.conversationId);
  },

  async clear(conversationId: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["queue", "flushClaims"], "readwrite");
    const idx = tx.objectStore("queue").index("by-conversation");
    let cursor = await idx.openCursor(conversationId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore("flushClaims").delete(conversationId);
    await tx.done;
    notify(conversationId);
  },

  /**
   * Atomically claim the head of `conversationId`'s queue for flushing.
   *
   * Returns the head item plus a unique claim id, or `null` if the queue
   * is empty or another flusher is already running for this conversation.
   *
   * Stale claims (older than {@link STALE_CLAIM_MS}) are reaped here so a
   * crashed flusher can't lock the queue indefinitely.
   */
  async claimHead(
    conversationId: string,
  ): Promise<QueuedMessage | null> {
    const db = await getDb();
    const tx = db.transaction(["queue", "flushClaims"], "readwrite");
    const claimsStore = tx.objectStore("flushClaims");
    const existingClaim = await claimsStore.get(conversationId);
    const now = Date.now();
    if (existingClaim && now - existingClaim.claimedAt < STALE_CLAIM_MS) {
      // Another flusher is active.
      await tx.done;
      return null;
    }

    const queueIdx = tx.objectStore("queue").index("by-conversation");
    let cursor = await queueIdx.openCursor(conversationId);
    let head: QueuedMessage | null = null;
    while (cursor) {
      const v = cursor.value;
      if (head === null || v.createdAt < head.createdAt) head = v;
      cursor = await cursor.continue();
    }
    if (!head) {
      // No work; clear any stale claim row we may have just observed.
      if (existingClaim) await claimsStore.delete(conversationId);
      await tx.done;
      return null;
    }

    await claimsStore.put({
      conversationId,
      queuedMessageId: head.id,
      claimedAt: now,
    });
    await tx.done;
    return head;
  },

  /**
   * Release the flush claim for `conversationId`.
   *
   * If `success === true`, the queued message is also removed from the
   * queue (the caller successfully drained it into `chat-db` and called
   * `sendMessage`). If `success === false`, the message stays at the
   * head and only the claim is released, so the next flush attempt can
   * retry.
   */
  async releaseHead(
    conversationId: string,
    queuedMessageId: string,
    success: boolean,
  ): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["queue", "flushClaims"], "readwrite");
    const claim = await tx.objectStore("flushClaims").get(conversationId);
    // Only release if the claim still references the same id we held —
    // otherwise we'd be deleting some other flusher's claim.
    if (claim && claim.queuedMessageId === queuedMessageId) {
      await tx.objectStore("flushClaims").delete(conversationId);
      if (success) {
        await tx.objectStore("queue").delete(queuedMessageId);
      }
    } else if (success) {
      // Defensive: if the claim is gone (timed out and reaped) but the
      // caller still managed to flush, drop the queue row anyway.
      await tx.objectStore("queue").delete(queuedMessageId);
    }
    await tx.done;
    notify(conversationId);
  },

  /**
   * Test/debug helper. Reset the in-memory db handle so a fresh
   * `indexedDB` (e.g. fake-indexeddb in tests) is opened on next call.
   */
  _resetForTests(): void {
    dbPromise = null;
  },
};
