import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../chat-db";

const CONV = "conv-edit-truncation";

async function seedConv(id: string = CONV) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: null,
    ownedLtids: [],
    createdAt: 0,
    updatedAt: 0,
  });
}

async function seedMessage(
  id: string,
  role: "user" | "assistant",
  createdAt: number,
  text = "",
) {
  await chatDb.saveMessage({
    id,
    conversationId: CONV,
    role,
    content: text,
    parts: text ? [{ type: "text", text }] : [],
    createdAt,
  });
}

describe("chatDb.deleteMessagesFrom", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the target and every later message by createdAt", async () => {
    await seedConv();
    await seedMessage("u1", "user", 100, "hello");
    await seedMessage("a1", "assistant", 200, "world");
    await seedMessage("u2", "user", 300, "edit me");
    await seedMessage("a2", "assistant", 400, "old answer");
    await seedMessage("u3", "user", 500, "follow up");
    await seedMessage("a3", "assistant", 600, "follow answer");

    await chatDb.deleteMessagesFrom(CONV, "u2");

    const remaining = await chatDb.getMessages(CONV);
    expect(remaining.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("treats createdAt as a >= cutoff (target itself is removed)", async () => {
    await seedConv();
    await seedMessage("u1", "user", 100);
    await seedMessage("a1", "assistant", 200);

    await chatDb.deleteMessagesFrom(CONV, "u1");

    const remaining = await chatDb.getMessages(CONV);
    expect(remaining).toEqual([]);
  });

  /**
   * Regression guard for the user-message ID-mismatch bug. Previously
   * `handleSubmit` and the queue auto-flush persisted the user message
   * with `chatDb.saveMessage({ id: generateId(), ... })` and then called
   * the SDK's `sendMessage({ text, files })` (no id), letting the SDK
   * auto-generate a *different* UUID for the in-memory message. When
   * the user later tried to edit, `confirmEdit` called
   * `deleteMessagesFrom` with the SDK-generated id, which never matched
   * any chatDb row — so the silent no-op left every "deleted" message in
   * place. After refresh the stale tail reappeared above the new turn.
   *
   * The fix aligns the ids at the call sites; this test pins the
   * underlying chatDb contract so the warning fires loudly if a similar
   * caller-bug is ever reintroduced.
   */
  it("logs a warning and is a no-op when the messageId is not in the conversation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedConv();
    await seedMessage("u1", "user", 100);
    await seedMessage("a1", "assistant", 200);

    await chatDb.deleteMessagesFrom(CONV, "id-that-does-not-exist");

    const remaining = await chatDb.getMessages(CONV);
    expect(remaining.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnMessage] = warn.mock.calls[0];
    expect(warnMessage).toContain("id-that-does-not-exist");
    expect(warnMessage).toContain(CONV);
  });

  it("scopes deletion to the requested conversation", async () => {
    await seedConv();
    await chatDb.createConversation({
      id: "other",
      title: "other",
      spaceId: null,
      ownedLtids: [],
      createdAt: 0,
      updatedAt: 0,
    });
    await seedMessage("u1", "user", 100);
    await seedMessage("a1", "assistant", 200);
    // Other conversation has a message at the same createdAt as the
    // target — it must NOT be deleted.
    await chatDb.saveMessage({
      id: "other-u1",
      conversationId: "other",
      role: "user",
      content: "",
      parts: [],
      createdAt: 100,
    });

    await chatDb.deleteMessagesFrom(CONV, "u1");

    expect(await chatDb.getMessages(CONV)).toEqual([]);
    const otherMsgs = await chatDb.getMessages("other");
    expect(otherMsgs.map((m) => m.id)).toEqual(["other-u1"]);
  });
});
