// src/lib/spaces/saved-files-db.ts
//
// Tracks the relationship between a conversation file (in
// `conversations/<convId>/workspace/<filePath>`) and its promoted copy in a
// space's shared workspace (`spaces/<spaceId>/workspace/<spaceFilePath>`).
// Used by the "Save to space" affordance in the working folder list and the
// file viewer to surface a per-file glance state:
//
//   - "unsaved": no record for this (conversationId, filePath).
//   - "saved":   record exists and the source content (size + sha-256 hash)
//                still matches what was saved; the promoted copy is current.
//   - "stale":   record exists but the source has changed since the save;
//                the promoted copy is older than the conversation file.
//
// Stored in its own IDB (`openbrowse-saved-files`) so we don't entangle this
// fast-changing relationship with the chat / memory schemas. Lookups are
// keyed on `<conversationId>|<filePath>` and are O(1) per key. Cleanup is
// hooked into conversation-delete (cascade by `by-conversation` index) and
// DELETE_SPACE handling (cascade by `by-space` index) — see callers.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DB_NAME = "openbrowse-saved-files";
const DB_VERSION = 1;

export interface SavedFile {
  /** Composite primary key: `${conversationId}|${filePath}`. */
  key: string;
  /** Source conversation id. */
  conversationId: string;
  /** Workspace-relative path within the conversation, e.g. "notes.md". */
  filePath: string;
  /** Destination space id. */
  spaceId: string;
  /**
   * Workspace-relative path within the space's shared workspace. Usually
   * matches `filePath` but may differ historically; the field is the
   * authoritative pointer for "where in the space did this go".
   */
  spaceFilePath: string;
  /** Wall-clock time of the most recent save (ms since epoch). */
  savedAt: number;
  /** Source byte size at save time. Cheap pre-filter for the hash check. */
  sourceSize: number;
  /**
   * SHA-256 of the source bytes at save time, hex-encoded. Used to detect
   * whether the conversation file has been modified since the save (the
   * "stale" state).
   */
  sourceHashHex: string;
}

interface SavedFilesDB extends DBSchema {
  savedFiles: {
    key: string;
    value: SavedFile;
    indexes: {
      "by-conversation": string;
      "by-space": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<SavedFilesDB>> | null = null;

function getDb(): Promise<IDBPDatabase<SavedFilesDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SavedFilesDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore("savedFiles", { keyPath: "key" });
        store.createIndex("by-conversation", "conversationId");
        store.createIndex("by-space", "spaceId");
      },
    });
  }
  return dbPromise;
}

function makeKey(conversationId: string, filePath: string): string {
  // `|` doesn't appear in OPFS paths or UUIDs in this codebase, so it's a
  // safe separator and avoids the cost of JSON encoding for the hot path.
  return `${conversationId}|${filePath}`;
}

/**
 * Compute SHA-256 of a byte source as a lowercase hex string. Used by both
 * `recordSave` (at save time) and `getStatus` (to compare current source
 * against the recorded hash). Streams via WebCrypto, which is available in
 * the extension runtime and in Node 18+ (test environment).
 */
export async function sha256Hex(source: Blob | Uint8Array | ArrayBuffer): Promise<string> {
  let buffer: ArrayBuffer;
  if (source instanceof Blob) {
    buffer = await source.arrayBuffer();
  } else if (source instanceof Uint8Array) {
    buffer = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;
  } else {
    buffer = source;
  }
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export type SavedStatus =
  | { state: "unsaved" }
  | { state: "saved"; record: SavedFile }
  | { state: "stale"; record: SavedFile };

export const savedFilesDb = {
  /**
   * Look up the saved-state of a conversation file against the active
   * space. Pass the file's *current* size + hash so we can decide whether
   * the recorded copy is still current ("saved") or out of date ("stale").
   *
   * Pass `currentSourceSize: null` / `currentSourceHashHex: null` to skip
   * the staleness check (returns `saved` whenever a record exists).
   *
   * Returns `unsaved` when:
   *   - no record exists for (conversationId, filePath), OR
   *   - the recorded `spaceId` doesn't match the active one (the file was
   *     saved into a different space; that's a different relationship and
   *     shouldn't be reported in the current scope).
   */
  async getStatus({
    conversationId,
    filePath,
    spaceId,
    currentSourceSize,
    currentSourceHashHex,
  }: {
    conversationId: string;
    filePath: string;
    spaceId: string | null;
    currentSourceSize: number | null;
    currentSourceHashHex: string | null;
  }): Promise<SavedStatus> {
    if (!spaceId) return { state: "unsaved" };
    const db = await getDb();
    const record = await db.get("savedFiles", makeKey(conversationId, filePath));
    if (!record) return { state: "unsaved" };
    if (record.spaceId !== spaceId) return { state: "unsaved" };
    if (
      currentSourceSize == null ||
      currentSourceHashHex == null ||
      (record.sourceSize === currentSourceSize &&
        record.sourceHashHex === currentSourceHashHex)
    ) {
      return { state: "saved", record };
    }
    return { state: "stale", record };
  },

  /**
   * Look up the raw record without a staleness comparison. Used when the
   * caller already knows it doesn't need to compute a hash (e.g. just to
   * check whether *any* save exists for cleanup purposes).
   */
  async get(
    conversationId: string,
    filePath: string,
  ): Promise<SavedFile | undefined> {
    const db = await getDb();
    return db.get("savedFiles", makeKey(conversationId, filePath));
  },

  /**
   * Persist a save record. Overwrites any prior record for the same
   * (conversationId, filePath) — the saved-to-space contract is "the
   * latest save is the canonical pointer."
   */
  async recordSave(input: Omit<SavedFile, "key">): Promise<SavedFile> {
    const db = await getDb();
    const record: SavedFile = {
      key: makeKey(input.conversationId, input.filePath),
      ...input,
    };
    await db.put("savedFiles", record);
    notifyChanged({
      conversationId: record.conversationId,
      filePath: record.filePath,
      spaceId: record.spaceId,
    });
    return record;
  },

  /**
   * Cascade-delete all records for a conversation. Hooked into
   * `chatDb.deleteConversation` so a deleted conversation doesn't leave
   * dangling save records pointing at OPFS files that may also have been
   * removed.
   */
  async clearForConversation(conversationId: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("savedFiles", "readwrite");
    const index = tx.store.index("by-conversation");
    let cursor = await index.openCursor(conversationId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
    notifyChanged({ conversationId });
  },

  /**
   * Cascade-delete all records targeting a space. Hooked into the
   * background DELETE_SPACE handler.
   */
  async clearForSpace(spaceId: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("savedFiles", "readwrite");
    const index = tx.store.index("by-space");
    let cursor = await index.openCursor(spaceId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
    notifyChanged({ spaceId });
  },

  /**
   * List every save record for a conversation. Used by the working folder
   * card to render per-row saved/stale state in a single round-trip
   * instead of N keyed lookups.
   */
  async listForConversation(conversationId: string): Promise<SavedFile[]> {
    const db = await getDb();
    return db.getAllFromIndex("savedFiles", "by-conversation", conversationId);
  },

  /**
   * Test/debug helper. Reset the in-memory db handle so a fresh
   * `indexedDB` (e.g. fake-indexeddb in tests) is opened on next call.
   */
  _resetForTests(): void {
    dbPromise = null;
  },
};

// ─── Change broadcast ────────────────────────────────────────────────────

export interface SavedFilesChangedDetail {
  conversationId?: string;
  filePath?: string;
  spaceId?: string;
}

/**
 * Event bus for saved-file relationship changes. UI surfaces (working
 * folder card, file viewer) subscribe so they re-fetch status whenever a
 * record is inserted, overwritten, or cascade-deleted.
 *
 * The same DOM-event pattern as `vfsEvents` for consistency. Detail is a
 * narrow filter — listeners that care only about a specific conversation
 * can early-return on mismatch.
 */
export const savedFilesEvents = new EventTarget();

function notifyChanged(detail: SavedFilesChangedDetail) {
  savedFilesEvents.dispatchEvent(
    new CustomEvent("saved-files:changed", { detail }),
  );
}
