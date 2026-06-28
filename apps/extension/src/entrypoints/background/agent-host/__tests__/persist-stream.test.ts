import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUIMessage } from "@/lib/agent/message-types";
import {
  createAssistantStreamPersister,
  type AssistantStreamPersisterPort,
} from "../persist-stream";

/**
 * The SW-host persist-stream takes the same in-flight UIMessage stream the
 * renderer's `onFinish` used to consume and writes the assistant transcript
 * to chat-db incrementally. Key contract:
 *
 *  - Upsert by message.id (the AI SDK emits a growing same-id message as
 *    the run progresses).
 *  - Skip messages whose parts have no meaningful content (empty turns,
 *    bare step-start markers — same policy as the renderer's onFinish).
 *  - Update conversation.updatedAt on each persisted message so the
 *    conversation list reorders.
 *  - Provide a `final()` hook that returns the last-seen text (for
 *    diagnostic / scheduled-run return-value purposes), matching the
 *    subagent persister's return shape.
 *
 * We test against a fake `chatDb` port to keep the test hermetic from
 * IndexedDB. The production wiring uses the real chatDb.
 */

function userMsg(text: string): AgentUIMessage {
  return {
    id: `u-${Math.random().toString(36).slice(2, 6)}`,
    role: "user",
    parts: [{ type: "text", text }],
  } as unknown as AgentUIMessage;
}

function assistantMsg(id: string, text: string): AgentUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as unknown as AgentUIMessage;
}

function emptyAssistantMsg(id: string): AgentUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "step-start" }],
  } as unknown as AgentUIMessage;
}

describe("SW agent-host persist-stream", () => {
  let port: AssistantStreamPersisterPort;
  let saved: Array<{
    id: string;
    conversationId: string;
    role: string;
    parts: unknown[];
  }>;
  let updates: Array<{ id: string; updatedAt: number }>;

  beforeEach(() => {
    saved = [];
    updates = [];
    port = {
      saveMessage: vi.fn(async (msg) => {
        saved.push({
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.role,
          parts: msg.parts,
        });
      }),
      updateConversation: vi.fn(async (id, patch) => {
        updates.push({ id, updatedAt: patch.updatedAt ?? 0 });
      }),
    };
  });

  it("persists an assistant message with meaningful content", async () => {
    const persister = createAssistantStreamPersister("conv-A", port);
    await persister.persist(assistantMsg("a-1", "hello"));

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: "a-1",
      conversationId: "conv-A",
      role: "assistant",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("conv-A");
  });

  it("upserts by id when the same assistant message id is persisted again with growing content", async () => {
    const persister = createAssistantStreamPersister("conv-A", port);
    await persister.persist(assistantMsg("a-1", "hel"));
    await persister.persist(assistantMsg("a-1", "hello world"));

    // saveMessage called twice — both calls were for id "a-1".
    expect(port.saveMessage).toHaveBeenCalledTimes(2);
    expect(saved.map((s) => s.id)).toEqual(["a-1", "a-1"]);
  });

  it("skips assistant messages with no meaningful content", async () => {
    const persister = createAssistantStreamPersister("conv-A", port);
    await persister.persist(emptyAssistantMsg("a-empty"));

    expect(saved).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("ignores non-assistant messages", async () => {
    const persister = createAssistantStreamPersister("conv-A", port);
    await persister.persist(userMsg("hi"));

    expect(saved).toHaveLength(0);
  });

  it("final() returns the last text content seen", async () => {
    const persister = createAssistantStreamPersister("conv-A", port);
    await persister.persist(assistantMsg("a-1", "first"));
    await persister.persist(assistantMsg("a-1", "second"));
    await persister.persist(assistantMsg("a-2", "third"));

    expect(persister.final().finalText).toBe("third");
    expect(persister.final().messageCount).toBe(2);
  });

  it("handles two distinct conversation-scoped persisters independently", async () => {
    const a = createAssistantStreamPersister("conv-A", port);
    const b = createAssistantStreamPersister("conv-B", port);
    await a.persist(assistantMsg("m-A", "alpha"));
    await b.persist(assistantMsg("m-B", "beta"));

    expect(saved.map((s) => s.conversationId).sort()).toEqual([
      "conv-A",
      "conv-B",
    ]);
  });

  it("createdAt is stable across upserts for the same id", async () => {
    const persister = createAssistantStreamPersister("conv-A", port);
    const ts1 = vi.spyOn(Date, "now").mockReturnValueOnce(1000);
    await persister.persist(assistantMsg("a-1", "hi"));
    ts1.mockReturnValueOnce(2000);
    await persister.persist(assistantMsg("a-1", "hi there"));
    ts1.mockRestore();

    // We can't read createdAt out of the abstract port directly, so cover
    // it via the chatDb argument shape: both saveMessage calls should
    // carry the same createdAt for the same message id.
    const calls = (port.saveMessage as unknown as { mock: { calls: Array<[{ createdAt: number; id: string }]> } }).mock.calls;
    expect(calls[0]![0].id).toBe("a-1");
    expect(calls[1]![0].id).toBe("a-1");
    expect(calls[0]![0].createdAt).toBe(calls[1]![0].createdAt);
  });
});
