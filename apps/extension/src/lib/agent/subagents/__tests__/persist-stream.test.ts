import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentUIMessage } from "../../../types";
import { chatDb } from "../../../chat-db";
import {
  persistAssistantStream,
  persistDelegationMessage,
} from "../persist-stream";

async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe("persistDelegationMessage", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: "child-1",
      title: "child",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("saves the synthesized delegation prompt as a user message under the child conv", async () => {
    const id = await persistDelegationMessage(
      "child-1",
      "Task: extract products\n\nURLs:\n- https://a.example",
    );

    expect(id).toBeTruthy();
    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id,
      conversationId: "child-1",
      role: "user",
      content: "Task: extract products\n\nURLs:\n- https://a.example",
    });
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Task: extract products\n\nURLs:\n- https://a.example" },
    ]);
  });
});

describe("persistAssistantStream", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: "child-1",
      title: "child",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("persists the final assistant message after the stream completes", async () => {
    const finalMessage: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "I read the page." },
      ],
    };

    const result = await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([finalMessage]),
    });

    expect(result.finalText).toBe("I read the page.");
    expect(result.messageCount).toBe(1);

    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "asst-1",
      role: "assistant",
      content: "I read the page.",
    });
  });

  it("upserts the same message id as parts grow across stream emissions", async () => {
    const partial: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [{ type: "text", text: "Reading…" }],
    };
    const final: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Reading…" },
        { type: "text", text: " done." },
      ],
    };

    await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([partial, final]),
    });

    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("asst-1");
    expect(messages[0].content).toBe("Reading… done.");
  });

  it("persists multiple distinct assistant messages produced across the run", async () => {
    const a: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [{ type: "text", text: "first" }],
    };
    const b: AgentUIMessage = {
      id: "asst-2",
      role: "assistant",
      parts: [{ type: "text", text: "second" }],
    };

    await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([a, b]),
    });

    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(["asst-1", "asst-2"]);
  });

  it("calls onSummary with each accumulated text", async () => {
    const collected: string[] = [];
    const partial: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [{ type: "text", text: "first" }],
    };
    const final: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: " second" },
      ],
    };

    await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([partial, final]),
      onSummary: (s) => collected.push(s),
    });

    expect(collected).toEqual(["first", "first second"]);
  });

  it("skips empty messages (no meaningful content)", async () => {
    const stub: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [{ type: "step-start" }],
    };

    const result = await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([stub]),
    });

    expect(result.messageCount).toBe(0);
    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(0);
  });

  it("persists tool calls as part of the assistant message", async () => {
    const message: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          // AI SDK emits dynamic-tool with explicit toolName.
          type: "dynamic-tool",
          toolName: "readPage",
          toolCallId: "call-1",
          state: "output-available",
          input: { tabHandle: "t1" },
          output: { text: "page content" },
        } as AgentUIMessage["parts"][number],
        { type: "text", text: "Read the page." },
      ],
    };

    await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([message]),
    });

    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(1);
    const toolPart = messages[0].parts.find(
      (p) => p.type === "dynamic-tool",
    ) as { toolName?: string; toolCallId?: string } | undefined;
    expect(toolPart?.toolName).toBe("readPage");
    expect(toolPart?.toolCallId).toBe("call-1");
  });

  it("persists partial transcript when the stream throws mid-run", async () => {
    async function* throwingStream(): AsyncIterable<AgentUIMessage> {
      yield {
        id: "asst-1",
        role: "assistant",
        parts: [{ type: "text", text: "got partway" }],
      };
      throw new Error("network blip");
    }

    await expect(
      persistAssistantStream({
        childConversationId: "child-1",
        uiMessages: throwingStream(),
      }),
    ).rejects.toThrow(/network blip/);

    const messages = await chatDb.getMessages("child-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("got partway");
  });

  it("returns the captured transcript alongside persisted messages", async () => {
    const a: AgentUIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    };
    const b: AgentUIMessage = {
      id: "asst-2",
      role: "assistant",
      parts: [{ type: "text", text: "world" }],
    };

    const result = await persistAssistantStream({
      childConversationId: "child-1",
      uiMessages: asAsyncIterable([a, b]),
    });

    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[0]).toEqual({
      id: "asst-1",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(result.transcript[1].id).toBe("asst-2");
  });
});
