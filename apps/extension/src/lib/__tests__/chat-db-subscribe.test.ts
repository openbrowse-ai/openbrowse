import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../chat-db";

describe("chatDb.subscribeMessageChange", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("fires the listener with the conversation id when a message is saved", async () => {
    const listener = vi.fn();
    const unsubscribe = chatDb.subscribeMessageChange(listener);

    await chatDb.saveMessage({
      id: "m1",
      conversationId: "conv-A",
      role: "assistant",
      content: "hello",
      parts: [{ type: "text", text: "hello" }],
      createdAt: 100,
    });

    expect(listener).toHaveBeenCalledWith("conv-A");
    unsubscribe();
  });

  it("fires once per distinct conversation id when batch-saving", async () => {
    const listener = vi.fn();
    chatDb.subscribeMessageChange(listener);

    await chatDb.saveMessages([
      {
        id: "m1",
        conversationId: "conv-A",
        role: "assistant",
        content: "a",
        parts: [{ type: "text", text: "a" }],
        createdAt: 100,
      },
      {
        id: "m2",
        conversationId: "conv-A",
        role: "assistant",
        content: "b",
        parts: [{ type: "text", text: "b" }],
        createdAt: 101,
      },
      {
        id: "m3",
        conversationId: "conv-B",
        role: "assistant",
        content: "c",
        parts: [{ type: "text", text: "c" }],
        createdAt: 102,
      },
    ]);

    // conv-A fires once (despite 2 messages); conv-B fires once.
    expect(listener).toHaveBeenCalledTimes(2);
    const callArgs = listener.mock.calls.map((c) => c[0]).sort();
    expect(callArgs).toEqual(["conv-A", "conv-B"]);
  });

  it("unsubscribes cleanly", async () => {
    const listener = vi.fn();
    const unsubscribe = chatDb.subscribeMessageChange(listener);
    unsubscribe();

    await chatDb.saveMessage({
      id: "m1",
      conversationId: "conv-A",
      role: "assistant",
      content: "hello",
      parts: [{ type: "text", text: "hello" }],
      createdAt: 100,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates errors thrown by one listener from others", async () => {
    const good = vi.fn();
    chatDb.subscribeMessageChange(() => {
      throw new Error("listener boom");
    });
    chatDb.subscribeMessageChange(good);

    await chatDb.saveMessage({
      id: "m1",
      conversationId: "conv-A",
      role: "assistant",
      content: "hello",
      parts: [{ type: "text", text: "hello" }],
      createdAt: 100,
    });

    expect(good).toHaveBeenCalledWith("conv-A");
  });
});

describe("chatDb.subscribeConversationChange", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("fires the listener with the conversation id when a row is created", async () => {
    const listener = vi.fn();
    chatDb.subscribeConversationChange(listener);

    await chatDb.createConversation({
      id: "conv-A",
      title: "x",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
    });

    expect(listener).toHaveBeenCalledWith("conv-A");
  });

  it("fires the listener with the conversation id when a row is updated", async () => {
    await chatDb.createConversation({
      id: "conv-A",
      title: "x",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
    });

    const listener = vi.fn();
    chatDb.subscribeConversationChange(listener);

    await chatDb.updateConversation("conv-A", { subagentTraceTitle: "Reading" });

    expect(listener).toHaveBeenCalledWith("conv-A");
  });

  it("unsubscribes cleanly", async () => {
    const listener = vi.fn();
    const unsubscribe = chatDb.subscribeConversationChange(listener);
    unsubscribe();

    await chatDb.createConversation({
      id: "conv-A",
      title: "x",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates errors thrown by one listener from others", async () => {
    const good = vi.fn();
    chatDb.subscribeConversationChange(() => {
      throw new Error("conv listener boom");
    });
    chatDb.subscribeConversationChange(good);

    await chatDb.createConversation({
      id: "conv-A",
      title: "x",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
    });

    expect(good).toHaveBeenCalledWith("conv-A");
  });
});
