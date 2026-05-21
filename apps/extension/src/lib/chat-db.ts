import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SerializedUIPart, TodoItem } from "./types";
import { OPFS } from "./vfs/opfs";

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
      createdAt: number;
      updatedAt: number;
    };
    indexes: {
      "by-updated": number;
      "by-space": string;
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

function getDb(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    // v7: migrates legacy `{ type: "compaction", auto, ... }` parts
    // to the AI SDK's DataUIPart contract:
    // `{ type: "data-compaction", data: { auto, ... } }`.
    dbPromise = openDB<ChatDB>("openbrowse-chat", 7, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          const convStore = db.createObjectStore("conversations", {
            keyPath: "id",
          });
          convStore.createIndex("by-updated", "updatedAt");
          convStore.createIndex("by-space", "spaceId");

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
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async getConversation(
    id: string,
  ): Promise<ChatDB["conversations"]["value"] | undefined> {
    const db = await getDb();
    return db.get("conversations", id);
  },

  async createConversation(
    conv: Omit<ChatDB["conversations"]["value"], "ownedGroupId" | "ownedTabIds" | "todos"> &
      Partial<Pick<ChatDB["conversations"]["value"], "ownedGroupId" | "ownedTabIds" | "todos">>,
  ): Promise<void> {
    const db = await getDb();
    await db.put("conversations", {
      ownedGroupId: null,
      ownedTabIds: [],
      todos: [],
      ...conv,
    });
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
    const existing = await db.get("conversations", id);
    if (existing) {
      await db.put("conversations", { ...existing, ...updates });
    }
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
  },

  async saveMessages(msgs: ChatDB["messages"]["value"][]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("messages", "readwrite");
    for (const msg of msgs) {
      await tx.store.put(msg);
    }
    await tx.done;
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
    if (!target) return;
    const toDelete = msgs.filter((m) => m.createdAt >= target.createdAt);
    const tx = db.transaction("messages", "readwrite");
    for (const msg of toDelete) {
      await tx.store.delete(msg.id);
    }
    await tx.done;
  },
};
