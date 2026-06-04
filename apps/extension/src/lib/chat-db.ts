import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { queueDb } from "./queue-db";
import type { IsolationProfile, SubagentStatus } from "./agent/subagents/types";
import type { SerializedUIPart, TodoItem } from "./types";
import { OPFS } from "./vfs/opfs";

/**
 * Persisted handle map for a conversation. Handles (`t1`, `t2`, ...) are
 * stable identifiers the agent uses to address tabs in tool args. Backed
 * by a sync in-memory cache in `tab-handles.ts`; this field lets the cache
 * survive service-worker restarts and conversation switches.
 */
export interface PersistedHandleState {
  /** handle → chrome tab id */
  handles: Record<string, number>;
  /** Next handle counter (1-based, monotonic per conversation). */
  counter: number;
}

interface ChatDB extends DBSchema {
  conversations: {
    key: string;
    value: {
      id: string;
      title: string;
      spaceId: string | null;
      ownedGroupId: number | null;
      ownedTabIds: number[];
      todos?: TodoItem[];
      handleState?: PersistedHandleState;
      createdAt: number;
      updatedAt: number;
      // v8 — subagent lineage. All optional / nullable so pre-migration
      // rows still parse. See `Conversation` in lib/types.ts for the
      // public-facing shape that mirrors these fields.
      parentConversationId?: string | null;
      subagentSlug?: string | null;
      subagentStatus?: SubagentStatus | null;
      subagentFinalText?: string | null;
      subagentTraceTitle?: string | null;
      isolationProfile?: IsolationProfile | null;
      ephemeralWindowId?: number | null;
      // v12 — toolCallId of the parent's `delegate` tool call that
      // spawned this child conversation. Lets the parent's heal path
      // (and the SW startup reconciliation) link a healed delegate
      // part back to its specific child row so it can be finalized.
      // Optional: undefined for parent (root) conversations and for
      // child rows created before v12.
      parentToolCallId?: string | null;
      // Live-recorded connector/skill usage for the Context card. Optional;
      // undefined on rows created before this field existed. No migration
      // needed (keyPath store stores whole objects). Mirrors `Conversation`
      // in lib/types.ts.
      usedConnectorIds?: string[];
      loadedSkillNames?: string[];
      // v13 — completion marker for agent tab-cleanup. Optional; undefined
      // on rows created before v13 and on conversations never completed.
      lastCompletionApproved?: boolean;
      taskCompletedAt?: number;
    };
    indexes: {
      "by-updated": number;
      "by-space": string;
      "by-parent": string;
    };
  };
  messages: {
    key: string;
    value: {
      id: string;
      conversationId: string;
      role: "user" | "assistant" | "system";
      content: string;
      parts: SerializedUIPart[];
      createdAt: number;
      /**
       * True for assistant messages that are auto-compaction summaries.
       * The preceding user message is the compaction marker. See
       * `CompactionPart` in types.ts.
       */
      summary?: boolean;
    };
    indexes: {
      "by-conversation": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null;

/**
 * In-process pubsub for message-table mutations. Used by
 * `DelegateResult` (and other UI surfaces) to live-update when a
 * subagent persists messages under a child conversation.
 *
 * Cross-context delivery (sidepanel popup vs main panel) is not
 * implemented here — every existing UI subscriber lives in the same
 * JS context as the writer (the runner's persistAssistantStream
 * runs inside the side panel's `createAgentTransport` call). If we
 * later need cross-context, mirror queue-db's chrome.runtime
 * broadcast pattern.
 */
type MessageChangeListener = (conversationId: string) => void;
const messageChangeListeners = new Set<MessageChangeListener>();

function emitMessageChange(conversationId: string): void {
  for (const listener of messageChangeListeners) {
    try {
      listener(conversationId);
    } catch (err) {
      console.warn("[chat-db] message change listener threw:", err);
    }
  }
}

/**
 * Sibling pubsub for the `conversations` table. Fires after any
 * `createConversation` / `updateConversation` mutation. Used by the
 * subagent UI to live-update fields like `subagentTraceTitle`,
 * `subagentStatus`, etc. without a chat-db round-trip on every event.
 *
 * Mirrors the message-change pattern (in-process only — cross-context
 * delivery via chrome.runtime is out of scope; every existing
 * subscriber lives in the same JS context as the writer).
 */
type ConversationChangeListener = (conversationId: string) => void;
const conversationChangeListeners = new Set<ConversationChangeListener>();

function emitConversationChange(conversationId: string): void {
  for (const listener of conversationChangeListeners) {
    try {
      listener(conversationId);
    } catch (err) {
      console.warn("[chat-db] conversation change listener threw:", err);
    }
  }
}

function getDb(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    // v7: migrates legacy `{ type: "compaction", auto, ... }` parts
    // to the AI SDK's DataUIPart contract:
    // `{ type: "data-compaction", data: { auto, ... } }`.
    // v8: introduces `handleState` (tab-handle persistence) on conversations.
    // No data migration: the field is optional and tab-handles.ts treats
    // missing/empty state as a fresh map starting at counter 1.
    // v9: adds subagent lineage fields and the by-parent index.
    // v10: adds `subagentTraceTitle` (set by subagent via setTaskTitle).
    //      Optional field; no backfill required.
    // v11: renames `subagentSummary` → `subagentFinalText`. Storage rename
    //      only; the value's meaning is unchanged.
    // v12: adds `parentToolCallId` on conversations. Optional / nullable;
    //      no backfill (existing children stay unlinked, which is fine —
    //      the SW startup reconciliation pass also covers them via the
    //      blanket "running" sweep).
    // v13: adds `lastCompletionApproved` + `taskCompletedAt` on
    //      conversations for agent tab-cleanup. Optional; no backfill.
    dbPromise = openDB<ChatDB>("openbrowse-chat", 13, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          const convStore = db.createObjectStore("conversations", {
            keyPath: "id",
          });
          convStore.createIndex("by-updated", "updatedAt");
          convStore.createIndex("by-space", "spaceId");
          // by-parent is added properly by the v8 upgrade path; on a
          // fresh install we still create it here so v1→v8 first-time
          // bootstraps don't double-create.

          const msgStore = db.createObjectStore("messages", { keyPath: "id" });
          msgStore.createIndex("by-conversation", "conversationId");
        }

        if (oldVersion < 2) {
          const msgStore = transaction.objectStore("messages");
          const migrateMessages = async () => {
            let cursor = await msgStore.openCursor();
            while (cursor) {
              const record = cursor.value as Record<string, unknown>;
              const content =
                typeof record.content === "string" ? record.content : "";
              const parts: SerializedUIPart[] = [
                { type: "text", text: content },
              ];
              delete record.toolInvocations;
              record.parts = parts;
              if (record.role === "tool") record.role = "assistant";
              cursor.update(record as ChatDB["messages"]["value"]);
              cursor = await cursor.continue();
            }
          };
          migrateMessages();
        }

        if (oldVersion < 3) {
          // The `compaction` store was created here historically. We no
          // longer need it (compaction is message-based), so we don't
          // create it. v6 below removes any pre-existing copy.
        }

        if (oldVersion < 4) {
          const convStore = transaction.objectStore("conversations");
          const migrateConversations = async () => {
            let cursor = await convStore.openCursor();
            while (cursor) {
              const record = cursor.value as Record<string, unknown>;
              if (record.ownedGroupId === undefined) record.ownedGroupId = null;
              if (!Array.isArray(record.ownedTabIds)) record.ownedTabIds = [];
              cursor.update(record as ChatDB["conversations"]["value"]);
              cursor = await cursor.continue();
            }
          };
          migrateConversations();
        }

        if (oldVersion < 5) {
          const convStore = transaction.objectStore("conversations");
          const migrateConversationsTodos = async () => {
            let cursor = await convStore.openCursor();
            while (cursor) {
              const record = cursor.value as Record<string, unknown>;
              if (record.todos === undefined) record.todos = [];
              cursor.update(record as ChatDB["conversations"]["value"]);
              cursor = await cursor.continue();
            }
          };
          migrateConversationsTodos();
          
          // Add activatedSkills to compaction data — no schema changes needed,
          // as it's an optional array inside the value object.
        }

        if (oldVersion < 6) {
          // Drop the legacy `compaction` object store. Compaction events
          // are now persisted as regular messages in the `messages` store.
          if (db.objectStoreNames.contains("compaction" as never)) {
            db.deleteObjectStore("compaction" as never);
          }
        }
        if (oldVersion < 7) {
          const msgStore = transaction.objectStore("messages");
          const migrateCompactionParts = async () => {
            let cursor = await msgStore.openCursor();
            while (cursor) {
              const record = cursor.value as Record<string, unknown>;
              let changed = false;
              if (Array.isArray(record.parts)) {
                const newParts = record.parts.map((p) => {
                  if (p && typeof p === "object" && "type" in p && p.type === "compaction") {
                    changed = true;
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { type: _type, ...data } = p as Record<string, unknown>;
                    return { type: "data-compaction", data };
                  }
                  return p;
                });
                if (changed) {
                  record.parts = newParts;
                  cursor.update(record as ChatDB["messages"]["value"]);
                }
              }
              cursor = await cursor.continue();
            }
          };
          migrateCompactionParts();
        }

        if (oldVersion < 8) {
          // `handleState` is optional on the conversation record; tab-handles.ts
          // treats `undefined` as "fresh map, counter starts at 1". No data
          // backfill required — the schema bump only signals the field exists.
        }

        if (oldVersion < 9) {
          // Subagent lineage. Existing rows have no parent — set the field
          // to null so the by-parent index treats them uniformly. The
          // remaining lineage fields are optional and read back as
          // undefined for pre-v9 rows; that's fine for the UI.
          const convStore = transaction.objectStore("conversations");
          if (!convStore.indexNames.contains("by-parent" as never)) {
            convStore.createIndex("by-parent", "parentConversationId");
          }
          const migrateConversationsParent = async () => {
            let cursor = await convStore.openCursor();
            while (cursor) {
              const record = cursor.value as Record<string, unknown>;
              if (record.parentConversationId === undefined) {
                record.parentConversationId = null;
              }
              cursor.update(record as ChatDB["conversations"]["value"]);
              cursor = await cursor.continue();
            }
          };
          migrateConversationsParent();
        }

        if (oldVersion < 10) {
          // `subagentTraceTitle` is optional on the conversation record;
          // no data backfill needed — pre-v10 rows read back with
          // `subagentTraceTitle === undefined`, and the UI falls back to
          // the delegation `task` string when unset. The schema bump
          // exists only to mark the field's introduction so the
          // structured clone path inside IndexedDB recognizes it.
        }

        if (oldVersion < 11) {
          // v11: rename `subagentSummary` → `subagentFinalText` on conversations.
          // Same content (the last assistant text-part the subagent emitted) — the
          // rename clarifies it isn't a generated summary.
          const convStore = transaction.objectStore("conversations");
          const migrateConversationsFinalText = async () => {
            let cursor = await convStore.openCursor();
            while (cursor) {
              const record = cursor.value as Record<string, unknown>;
              if ("subagentSummary" in record) {
                if (
                  record.subagentSummary !== undefined &&
                  record.subagentSummary !== null
                ) {
                  record.subagentFinalText = record.subagentSummary;
                }
                delete record.subagentSummary;
                cursor.update(record as ChatDB["conversations"]["value"]);
              }
              cursor = await cursor.continue();
            }
          };
          migrateConversationsFinalText();
        }

        if (oldVersion < 12) {
          // v12: `parentToolCallId` is optional. No backfill needed —
          // pre-v12 child rows simply read back with the field undefined,
          // which the heal path treats as "unlinked" (falling back to
          // the SW startup blanket reconciliation pass).
        }

        if (oldVersion < 13) {
          // Completion marker fields are optional and default to undefined;
          // no backfill needed. New writes set them via updateConversation.
        }
      },
    });
  }
  return dbPromise;
}

export const chatDb = {
  async listConversations(
    spaceId?: string | null,
  ): Promise<ChatDB["conversations"]["value"][]> {
    const db = await getDb();
    let all: ChatDB["conversations"]["value"][];
    if (spaceId) {
      all = await db.getAllFromIndex("conversations", "by-space", spaceId);
    } else {
      all = await db.getAll("conversations");
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },

  /**
   * Return the immediate children of a parent conversation, ordered by
   * creation time ascending (oldest subagent run first). Used by the
   * side panel to render nested subagent runs under the parent.
   */
  async listChildren(
    parentConversationId: string,
  ): Promise<ChatDB["conversations"]["value"][]> {
    const db = await getDb();
    const all = await db.getAllFromIndex(
      "conversations",
      "by-parent",
      parentConversationId,
    );
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },

  /**
   * Find a child conversation by the parent `delegate` tool call id
   * that spawned it. Returns undefined when no row matches (e.g. the
   * child was created before v12 introduced `parentToolCallId`, or the
   * parent had a different toolCallId).
   *
   * Implemented as an in-memory filter over `by-parent` rather than a
   * dedicated index because the parent typically has only a handful of
   * children and we already query by parent id elsewhere.
   */
  async findChildByParentToolCallId(
    parentConversationId: string,
    parentToolCallId: string,
  ): Promise<ChatDB["conversations"]["value"] | undefined> {
    const db = await getDb();
    const all = await db.getAllFromIndex(
      "conversations",
      "by-parent",
      parentConversationId,
    );
    return all.find((c) => c.parentToolCallId === parentToolCallId);
  },

  async getConversation(
    id: string,
  ): Promise<ChatDB["conversations"]["value"] | undefined> {
    const db = await getDb();
    return db.get("conversations", id);
  },

  async createConversation(
    conv: Omit<
      ChatDB["conversations"]["value"],
      "ownedGroupId" | "ownedTabIds" | "todos" | "handleState"
    > &
      Partial<
        Pick<
          ChatDB["conversations"]["value"],
          "ownedGroupId" | "ownedTabIds" | "todos" | "handleState"
        >
      >,
  ): Promise<void> {
    const db = await getDb();
    await db.put("conversations", {
      ownedGroupId: null,
      ownedTabIds: [],
      todos: [],
      ...conv,
    });
    emitConversationChange(conv.id);
    // Broadcast so other extension contexts (home tab, side panels, popups)
    // can refresh their conversation lists. Always sidebar-relevant.
    try {
      chrome.runtime
        ?.sendMessage?.({
          type: "CONVERSATION_CREATED",
          conversationId: conv.id,
          spaceId: conv.spaceId,
        })
        ?.catch?.(() => {});
    } catch {
      // Non-extension context (tests). Safe to ignore.
    }
  },

  async updateConversation(
    id: string,
    updates: Partial<ChatDB["conversations"]["value"]>,
  ): Promise<void> {
    const db = await getDb();
    // Read-modify-write inside a single transaction. idb serializes
    // readwrite transactions on the same store within a connection, so
    // concurrent updateConversation calls can't drop each other's writes
    // (which would happen with a separate db.get / db.put pair if a
    // second writer's `get` raced with the first writer's `put`).
    const tx = db.transaction("conversations", "readwrite");
    const existing = await tx.store.get(id);
    if (existing) {
      await tx.store.put({ ...existing, ...updates });
    }
    await tx.done;
    emitConversationChange(id);
    // Only broadcast for fields that materially affect conversation-list UIs.
    // Excludes high-frequency churn like `updatedAt` (per message turn),
    // `ownedTabIds`/`ownedGroupId` (tab-scoping reconciliation), and `todos`
    // (per agent step). Same-window UIs don't refetch on those either, so
    // broadcasting them would make cross-window behavior more aggressive
    // than same-window — wrong direction.
    const sidebarRelevant =
      updates.title !== undefined || updates.spaceId !== undefined;
    if (sidebarRelevant) {
      try {
        chrome.runtime
          ?.sendMessage?.({
            type: "CONVERSATION_UPDATED",
            conversationId: id,
            fields: Object.keys(updates),
          })
          ?.catch?.(() => {});
      } catch {
        // Non-extension context (tests). Safe to ignore.
      }
    }
  },

  async deleteConversation(id: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["conversations", "messages"], "readwrite");
    await tx.objectStore("conversations").delete(id);
    const msgIndex = tx.objectStore("messages").index("by-conversation");
    let cursor = await msgIndex.openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    
    await tx.done;

    // Cascade-clear any queued (un-sent) messages for this conversation.
    // Without this, a deleted conversation would resurrect dangling
    // queue rows the next time anything iterates the queue.
    try {
      await queueDb.clear(id);
    } catch (e) {
      console.warn("Failed to clear message queue for deleted conversation", e);
    }

    // Clean up ephemeral VFS container
    try {
      await OPFS.rm(`conversations/${id}`, { recursive: true });
    } catch (e) {
      console.warn("Failed to delete conversation VFS container", e);
    }

    // Broadcast so other extension contexts (popups, side panels, home tab)
    // can react to a conversation disappearing — e.g. the global chat popup
    // resetting to a fresh chat if the deleted conversation was active.
    // chrome.runtime.sendMessage does not deliver to the sender, so the
    // calling UI doesn't double-handle (it already refreshes locally).
    try {
      chrome.runtime
        ?.sendMessage?.({ type: "CONVERSATION_DELETED", conversationId: id })
        ?.catch?.(() => {});
    } catch {
      // Non-extension context (e.g. unit tests). Safe to ignore.
    }
  },

  async getMessages(
    conversationId: string,
  ): Promise<ChatDB["messages"]["value"][]> {
    const db = await getDb();
    const msgs = await db.getAllFromIndex(
      "messages",
      "by-conversation",
      conversationId,
    );
    return msgs.sort((a, b) => a.createdAt - b.createdAt);
  },

  async saveMessage(msg: ChatDB["messages"]["value"]): Promise<void> {
    const db = await getDb();
    await db.put("messages", msg);
    emitMessageChange(msg.conversationId);
  },

  async saveMessages(msgs: ChatDB["messages"]["value"][]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("messages", "readwrite");
    for (const msg of msgs) {
      await tx.store.put(msg);
    }
    await tx.done;
    // De-dup conversation ids before emitting so a save of N messages
    // for one conv only fires one listener call.
    const convIds = new Set(msgs.map((m) => m.conversationId));
    for (const convId of convIds) emitMessageChange(convId);
  },

  /**
   * Subscribe to message-table mutations. Listener receives the
   * `conversationId` of the affected conversation. Returns an
   * unsubscribe function.
   */
  subscribeMessageChange(listener: MessageChangeListener): () => void {
    messageChangeListeners.add(listener);
    return () => {
      messageChangeListeners.delete(listener);
    };
  },

  /**
   * Subscribe to `conversations`-table mutations (create + update).
   * Mirrors `subscribeMessageChange` for the conversation row itself —
   * lets UI surfaces live-update when subagent lineage fields like
   * `subagentTraceTitle` or `subagentStatus` change.
   *
   * Returns an unsubscribe function. Same in-process-only delivery
   * semantics as the message listener.
   */
  subscribeConversationChange(
    listener: ConversationChangeListener,
  ): () => void {
    conversationChangeListeners.add(listener);
    return () => {
      conversationChangeListeners.delete(listener);
    };
  },

  async deleteMessagesFrom(
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const db = await getDb();
    const msgs = await db.getAllFromIndex(
      "messages",
      "by-conversation",
      conversationId,
    );
    const target = msgs.find((m) => m.id === messageId);
    if (!target) {
      // Loud rather than silent: a missing target almost always means the
      // caller passed an id from one source (e.g. the AI SDK's in-memory
      // chat state) that does not match the id stored in chatDb. The
      // historical "edit user message leaves stale tail in chat-db"
      // bug was caused by exactly this kind of id mismatch in
      // `handleSubmit` / queue-flush, and went undetected for months
      // because this function returned silently. Surface it now so the
      // next regression is visible at the first repro.
      console.warn(
        `[chatDb] deleteMessagesFrom: messageId ${messageId} not found in conversation ${conversationId}; nothing deleted`,
      );
      return;
    }
    const toDelete = msgs.filter((m) => m.createdAt >= target.createdAt);
    const tx = db.transaction("messages", "readwrite");
    for (const msg of toDelete) {
      await tx.store.delete(msg.id);
    }
    await tx.done;
  },

  /**
   * Test/debug helper. Reset the in-memory db handle so a fresh
   * `indexedDB` (e.g. fake-indexeddb in tests) is opened on next call.
   */
  _resetForTests(): void {
    dbPromise = null;
  },
};
