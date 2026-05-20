import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SerializedUIPart, TodoItem } from "./types";

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
    };
    indexes: {
      "by-conversation": string;
    };
  };
  compaction: {
    key: string;
    value: {
      conversationId: string;
      summary: string;
      tailStartMessageId: string;
      previousSummary?: string;
      compactedAt: number;
      attempts: number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null;

function getDb(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatDB>("openbrowse-chat", 5, {
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
          db.createObjectStore("compaction", { keyPath: "conversationId" });
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
  },

  async deleteConversation(id: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["conversations", "messages", "compaction"], "readwrite");
    await tx.objectStore("conversations").delete(id);
    await tx.objectStore("compaction").delete(id);
    const msgIndex = tx.objectStore("messages").index("by-conversation");
    let cursor = await msgIndex.openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
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

  async getCompactionState(conversationId: string): Promise<ChatDB["compaction"]["value"] | undefined> {
    const db = await getDb();
    return db.get("compaction", conversationId);
  },

  async saveCompactionState(state: ChatDB["compaction"]["value"]): Promise<void> {
    const db = await getDb();
    await db.put("compaction", state);
  },

  async deleteCompactionState(conversationId: string): Promise<void> {
    const db = await getDb();
    await db.delete("compaction", conversationId);
  },
};
