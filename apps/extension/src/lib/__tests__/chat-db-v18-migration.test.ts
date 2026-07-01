/**
 * Tests for the chat-db v18 upgrade hop, which adds two new optional
 * fields to the `conversations` store: `source` (provenance —
 * "user" | "subagent" | "mcp") and `mcpHostName` (display name of the
 * MCP host that spawned the run, when source === "mcp").
 *
 * The migration backfills `source` from `subagentSlug` on pre-existing
 * rows so the chat list filter (Task 17) renders correctly without
 * requiring a separate cleanup pass: rows with a non-empty
 * `subagentSlug` become `source: "subagent"`, everything else becomes
 * `source: "user"`. `mcpHostName` is defaulted to `null` for all
 * pre-existing rows — only post-migration writes from the MCP task
 * runner ever set it to a non-null value.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatDb } from "../chat-db";

async function openDbAtVersion(version: number) {
  const { openDB } = await import("idb");
  return openDB("openbrowse-chat", version, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("conversations")) {
        const conv = db.createObjectStore("conversations", { keyPath: "id" });
        conv.createIndex("by-space", "spaceId");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const msg = db.createObjectStore("messages", { keyPath: "id" });
        msg.createIndex("by-conversation", "conversationId");
      }
    },
  });
}

async function seedV17Conversation(row: {
  id: string;
  title: string;
  spaceId?: string | null;
  subagentSlug?: string | null;
}) {
  // v17 = v16 schema + optional `mode`/`plan` fields. No structural
  // differences for our seed (we don't seed mode/plan).
  const db = await openDbAtVersion(17);
  await db.put("conversations", {
    id: row.id,
    title: row.title,
    spaceId: row.spaceId ?? null,
    ownedGroupId: null,
    ownedLtids: [],
    createdAt: 0,
    updatedAt: 0,
    subagentSlug: row.subagentSlug ?? null,
  });
  db.close();
}

beforeEach(() => {
  // Fresh in-memory IDB factory per test so a seeded v17 fixture
  // doesn't bleed into the next case and so re-opening the DB at v18
  // actually re-runs the upgrade callback.
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
});

afterEach(() => {
  chatDb._resetForTests();
});

describe("chat-db v18: source + mcpHostName", () => {
  it("user-rooted conversations (no parent, no subagent slug) default to source='user'", async () => {
    await seedV17Conversation({ id: "c1", title: "User chat" });
    const c = await chatDb.getConversation("c1");
    expect(c?.source).toBe("user");
    expect(c?.mcpHostName).toBeNull();
  });

  it("subagent conversations (subagentSlug set) default to source='subagent'", async () => {
    await seedV17Conversation({
      id: "c2",
      title: "Subagent run",
      subagentSlug: "tab-cleaner",
    });
    const c = await chatDb.getConversation("c2");
    expect(c?.source).toBe("subagent");
    expect(c?.mcpHostName).toBeNull();
  });

  it("newly created conversations default source='user' when not specified", async () => {
    await chatDb.createConversation({
      id: "c3",
      title: "Fresh",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    const c = await chatDb.getConversation("c3");
    expect(c?.source).toBe("user");
  });

  it("createConversation accepts source='mcp' + mcpHostName", async () => {
    await chatDb.createConversation({
      id: "c4",
      title: "MCP task",
      spaceId: null,
      source: "mcp",
      mcpHostName: "Claude Desktop",
      createdAt: 0,
      updatedAt: 0,
    });
    const c = await chatDb.getConversation("c4");
    expect(c?.source).toBe("mcp");
    expect(c?.mcpHostName).toBe("Claude Desktop");
  });
});
