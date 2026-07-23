import { chatDb } from "@/lib/chat-db";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    extractChatMentionsFromText,
    formatChatMentionContext,
} from "../ChatInput";

beforeEach(() => {
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
});

/** Seed a conversation with the given user/assistant text messages. */
async function seedChat(
  id: string,
  title: string,
  msgs: { role: "user" | "assistant" | "system"; text: string; summary?: boolean }[],
) {
  await chatDb.createConversation({
    id,
    title,
    spaceId: null,
    ownedGroupId: null,
    ownedLtids: [],
    createdAt: 0,
    updatedAt: 0,
  });
  let i = 0;
  for (const m of msgs) {
    i += 1;
    await chatDb.saveMessage({
      id: `${id}-m${i}`,
      conversationId: id,
      role: m.role,
      content: m.text,
      parts: [{ type: "text", text: m.text }],
      createdAt: i,
      ...(m.summary ? { summary: true } : {}),
    });
  }
}

describe("extractChatMentionsFromText", () => {
  it("parses a single chat mention token", () => {
    expect(
      extractChatMentionsFromText("recall #[Roadmap](chat:conv-1) please"),
    ).toEqual([{ title: "Roadmap", conversationId: "conv-1" }]);
  });

  it("parses multiple mentions and de-duplicates by conversation id", () => {
    expect(
      extractChatMentionsFromText(
        "#[A](chat:conv-1) and #[B](chat:conv-2) and again #[A dup](chat:conv-1)",
      ),
    ).toEqual([
      { title: "A", conversationId: "conv-1" },
      { title: "B", conversationId: "conv-2" },
    ]);
  });

  it("ignores tab mentions and ordinary markdown links", () => {
    expect(
      extractChatMentionsFromText(
        "@[Tab](https://x.test) see [docs](https://y.test)",
      ),
    ).toEqual([]);
  });

  it("returns [] when there are no mentions", () => {
    expect(extractChatMentionsFromText("just plain text")).toEqual([]);
  });
});

describe("formatChatMentionContext — verbatim (short chats)", () => {
  it("returns an empty string when there are no chat mentions", async () => {
    expect(await formatChatMentionContext("no mentions here")).toBe("");
  });

  it("inlines the referenced conversation's transcript", async () => {
    await seedChat("conv-1", "Roadmap", [
      { role: "user", text: "What should we ship first?" },
      { role: "assistant", text: "Start with the importer." },
    ]);

    const ctx = await formatChatMentionContext("recap #[Roadmap](chat:conv-1)");

    expect(ctx).toContain("<Mentioned chats>");
    expect(ctx).toContain("[Chat: Roadmap]");
    expect(ctx).toContain("User: What should we ship first?");
    expect(ctx).toContain("Assistant: Start with the importer.");
    expect(ctx).toContain("</Mentioned chats>");
  });

  it("skips system rows and compaction summaries", async () => {
    await seedChat("conv-2", "Support", [
      { role: "system", text: "system prompt" },
      { role: "assistant", text: "compaction summary", summary: true },
      { role: "user", text: "real question" },
    ]);

    const ctx = await formatChatMentionContext("#[Support](chat:conv-2)");

    expect(ctx).toContain("User: real question");
    expect(ctx).not.toContain("system prompt");
    expect(ctx).not.toContain("compaction summary");
  });

  it("renders a placeholder when the conversation has no usable messages", async () => {
    await seedChat("conv-3", "Empty", []);
    const ctx = await formatChatMentionContext("#[Empty](chat:conv-3)");
    expect(ctx).toContain("[Chat: Empty]");
    expect(ctx).toContain("(No messages)");
  });

  it("does not summarize when under the token threshold", async () => {
    await seedChat("small-1", "Small", [{ role: "user", text: "hi" }]);
    const summarize = vi.fn(async () => "SHOULD NOT RUN");

    const ctx = await formatChatMentionContext("#[Small](chat:small-1)", {
      maxTokens: 100_000,
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(ctx).toContain("User: hi");
    expect(ctx).not.toContain("summarized from");
  });
});

describe("formatChatMentionContext — long-chat summarization", () => {
  it("summarizes instead of inlining when over the token threshold", async () => {
    await seedChat("big-1", "Big", [
      { role: "user", text: "a long planning discussion" },
      { role: "assistant", text: "many detailed steps" },
    ]);
    const summarize = vi.fn(async () => "SUMMARY GIST");

    // maxTokens: 0 forces the summarization path for any non-empty chat.
    const ctx = await formatChatMentionContext("recap #[Big](chat:big-1)", {
      maxTokens: 0,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(ctx).toContain("[Chat: Big] (summarized from 2 messages)");
    expect(ctx).toContain("SUMMARY GIST");
    // The raw transcript should NOT be inlined when summarized.
    expect(ctx).not.toContain("User: a long planning discussion");
  });

  it("reuses the cached summary on a repeat mention (no second model call)", async () => {
    await seedChat("big-2", "Cached", [{ role: "user", text: "question one" }]);
    const summarize = vi.fn(async () => "CACHED SUMMARY");

    await formatChatMentionContext("#[Cached](chat:big-2)", {
      maxTokens: 0,
      summarize,
    });
    const ctx2 = await formatChatMentionContext("again #[Cached](chat:big-2)", {
      maxTokens: 0,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(ctx2).toContain("CACHED SUMMARY");
  });

  it("re-summarizes when the chat gains a message (cache invalidation)", async () => {
    await seedChat("big-3", "Growing", [{ role: "user", text: "first" }]);
    const summarize = vi
      .fn()
      .mockResolvedValueOnce("SUMMARY V1")
      .mockResolvedValueOnce("SUMMARY V2");

    const ctx1 = await formatChatMentionContext("#[Growing](chat:big-3)", {
      maxTokens: 0,
      summarize,
    });
    expect(ctx1).toContain("SUMMARY V1");

    await chatDb.saveMessage({
      id: "big-3-m2",
      conversationId: "big-3",
      role: "assistant",
      content: "second",
      parts: [{ type: "text", text: "second" }],
      createdAt: 2,
    });

    const ctx2 = await formatChatMentionContext("#[Growing](chat:big-3)", {
      maxTokens: 0,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(ctx2).toContain("SUMMARY V2");
  });

  it("falls back to a truncated transcript when summarization is unavailable", async () => {
    await seedChat("big-4", "NoModel", [
      { role: "user", text: "the actual question text" },
    ]);
    const summarize = vi.fn(async () => null);

    const ctx = await formatChatMentionContext("#[NoModel](chat:big-4)", {
      maxTokens: 0,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(ctx).toContain("User: the actual question text");
    expect(ctx).not.toContain("summarized from");
  });
});
