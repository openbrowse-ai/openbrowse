/**
 * Tests for `chatDb.listUserConversations`, the chat-list filter that
 * excludes `source === "mcp"` rows from the main user-facing sidebar /
 * pickers. Subagent and pre-v18 rows (source undefined) must still
 * pass through.
 *
 * This is the user-facing wrapper around `listRootConversations`; the
 * MCP host-spawned tasks are surfaced in the dedicated "Background
 * Tasks" panel, not the main chat list.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatDb } from "../chat-db";

beforeEach(() => {
  // Fresh in-memory IDB factory per test so rows don't bleed between
  // cases.
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
});

afterEach(() => {
  chatDb._resetForTests();
});

describe("chat-db listUserConversations", () => {
  it("excludes conversations with source='mcp'", async () => {
    await chatDb.createConversation({
      id: "u1",
      title: "user chat",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
      source: "user",
    });
    await chatDb.createConversation({
      id: "m1",
      title: "mcp task",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
      source: "mcp",
      mcpHostName: "Cursor",
    });
    const list = await chatDb.listUserConversations();
    const ids = list.map((r) => r.id);
    expect(ids).toContain("u1");
    expect(ids).not.toContain("m1");
  });

  it("includes subagent conversations (source='subagent')", async () => {
    // Subagent runs that aren't children of another conversation
    // should still appear in the user-facing list (parent-less
    // subagent rows are rare but the filter must not drop them).
    await chatDb.createConversation({
      id: "s1",
      title: "subagent",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
      source: "subagent",
    });
    const list = await chatDb.listUserConversations();
    expect(list.map((r) => r.id)).toContain("s1");
  });

  it("forwards spaceId argument to the underlying list", async () => {
    await chatDb.createConversation({
      id: "global",
      title: "g",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
      source: "user",
    });
    await chatDb.createConversation({
      id: "scoped",
      title: "s",
      spaceId: "space-A",
      createdAt: 0,
      updatedAt: 0,
      source: "user",
    });
    const scoped = await chatDb.listUserConversations("space-A");
    expect(scoped.map((r) => r.id)).toEqual(["scoped"]);
  });
});
