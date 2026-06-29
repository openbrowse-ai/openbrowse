/**
 * Tests for the `approveToolCall` reload-race fix: when the user
 * clicks Approve (or Deny), the assistant message containing the
 * just-flipped tool part must be persisted to chat-db immediately so
 * a subsequent reload doesn't resurface the approval card.
 *
 * Tested at the `persistApprovedAssistantMessage` helper level (the
 * pure function `approveToolCall` calls) — exercising the full hook
 * with React Testing Library + a fake AI SDK Chat is heavier than
 * needed for the behavior under test, which is "given an in-memory
 * messages array with a flipped tool part, write the right row to
 * chat-db".
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistApprovedAssistantMessage } from "../useAgentChat";
import type { AgentUIMessage } from "@/lib/types";
import { chatDb } from "@/lib/chat-db";

async function seedConversation(id: string): Promise<void> {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: null,
    createdAt: 0,
    updatedAt: 0,
  });
}

describe("persistApprovedAssistantMessage", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("persists the assistant message containing the approved tool part to chat-db", async () => {
    await seedConversation("c1");

    // Seed the conversation with the pre-approval state — assistant
    // message has the proposePlan part still in `approval-requested`.
    // This is what the SW persister wrote during the first turn.
    await chatDb.saveMessage({
      id: "u1",
      conversationId: "c1",
      role: "user",
      content: "research keyboards",
      parts: [{ type: "text", text: "research keyboards" }],
      createdAt: 1,
    });
    await chatDb.saveMessage({
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          toolCallId: "tc-1",
          state: "approval-requested",
          input: { goal: "g", sites: [], todos: [], allowNetwork: false },
          approval: { id: "ap-1" },
        },
      ],
      createdAt: 2,
    });

    // In-memory messages reflect the post-click state — the SDK has
    // already flipped the part to `approval-responded` via
    // `addToolApprovalResponse`. `persistApprovedAssistantMessage` is
    // what aligns chat-db with the in-memory state.
    const inMemory: AgentUIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "research keyboards" }],
      } as AgentUIMessage,
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "proposePlan",
            toolCallId: "tc-1",
            state: "approval-responded",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            approval: { id: "ap-1", approved: true },
          },
        ] as unknown as AgentUIMessage["parts"],
      } as AgentUIMessage,
    ];

    const persisted = await persistApprovedAssistantMessage(
      "c1",
      "tc-1",
      inMemory,
    );
    expect(persisted).toBe("a1");

    const after = await chatDb.getMessages("c1");
    const a = after.find((m) => m.id === "a1");
    expect(a).toBeDefined();
    const tool = a!.parts[0] as {
      state: string;
      approval?: { id?: string; approved?: boolean };
    };
    expect(tool.state).toBe("approval-responded");
    expect(tool.approval?.approved).toBe(true);
    // `findPendingPlanApproval` would now skip this part (it only
    // matches `approval-requested`) → reload won't resurface the card.
    expect(tool.state).not.toBe("approval-requested");
  });

  it("persists `approval-responded` with `approved: false` for denial", async () => {
    await seedConversation("c1");
    await chatDb.saveMessage({
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "navigate",
          toolCallId: "tc-1",
          state: "approval-requested",
          input: { url: "https://example.com" },
          approval: { id: "ap-1" },
        },
      ],
      createdAt: 1,
    });

    const inMemory: AgentUIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "navigate",
            toolCallId: "tc-1",
            state: "approval-responded",
            input: { url: "https://example.com" },
            approval: { id: "ap-1", approved: false },
          },
        ] as unknown as AgentUIMessage["parts"],
      } as AgentUIMessage,
    ];

    await persistApprovedAssistantMessage("c1", "tc-1", inMemory);
    const after = await chatDb.getMessages("c1");
    const tool = after[0].parts[0] as {
      state: string;
      approval?: { approved?: boolean };
    };
    expect(tool.state).toBe("approval-responded");
    expect(tool.approval?.approved).toBe(false);
  });

  it("returns null and does not write when the toolCallId is unknown", async () => {
    await seedConversation("c1");
    await chatDb.saveMessage({
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "x",
      parts: [{ type: "text", text: "x" }],
      createdAt: 1,
    });

    const inMemory: AgentUIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "x" }] as AgentUIMessage["parts"],
      } as AgentUIMessage,
    ];

    const persisted = await persistApprovedAssistantMessage(
      "c1",
      "nonexistent-toolcall",
      inMemory,
    );
    expect(persisted).toBeNull();

    // chat-db row is unchanged.
    const after = await chatDb.getMessages("c1");
    expect(after[0].parts).toEqual([{ type: "text", text: "x" }]);
  });

  it("preserves chat-db's existing createdAt across the save (does not regenerate timestamp)", async () => {
    await seedConversation("c1");
    const originalCreatedAt = 12345;
    await chatDb.saveMessage({
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          toolCallId: "tc-1",
          state: "approval-requested",
          input: { goal: "g", sites: [], todos: [], allowNetwork: false },
          approval: { id: "ap-1" },
        },
      ],
      createdAt: originalCreatedAt,
    });

    const inMemory: AgentUIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "proposePlan",
            toolCallId: "tc-1",
            state: "approval-responded",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            approval: { id: "ap-1", approved: true },
          },
        ] as unknown as AgentUIMessage["parts"],
      } as AgentUIMessage,
    ];

    await persistApprovedAssistantMessage("c1", "tc-1", inMemory);
    const after = await chatDb.getMessages("c1");
    // Keep the original timestamp so chat-db's load-order (sort by
    // createdAt) doesn't shuffle this message to the end.
    expect(after[0].createdAt).toBe(originalCreatedAt);
  });

  it("creates the row when chat-db has no prior entry for the message (race: click before SW persister wrote anything)", async () => {
    await seedConversation("c1");
    // No prior `a1` in chat-db.
    const inMemory: AgentUIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "proposePlan",
            toolCallId: "tc-1",
            state: "approval-responded",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            approval: { id: "ap-1", approved: true },
          },
        ] as unknown as AgentUIMessage["parts"],
      } as AgentUIMessage,
    ];

    const persisted = await persistApprovedAssistantMessage(
      "c1",
      "tc-1",
      inMemory,
    );
    expect(persisted).toBe("a1");

    const after = await chatDb.getMessages("c1");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("a1");
    const tool = after[0].parts[0] as { state: string };
    expect(tool.state).toBe("approval-responded");
  });

  it("preserves arbitrary unknown fields on the existing chat-db row (spread-existing contract)", async () => {
    // The implementation should `...existing` the prior chat-db row
    // and override only `parts` + `content`, matching
    // `persistHealedMessages`. That keeps any forward-compat or
    // optional fields the schema picks up later (or that other write
    // paths set ahead of us) from being silently dropped.
    //
    // The chat-db schema's currently-declared optional field is
    // `summary`; we use it as the test marker. The contract under
    // test isn't summary-specific — it's "the persist path doesn't
    // enumerate the row".
    await seedConversation("c1");
    await chatDb.saveMessage({
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "compaction summary",
      parts: [{ type: "text", text: "compaction summary" }],
      createdAt: 100,
      summary: true,
    });

    const inMemory: AgentUIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "proposePlan",
            toolCallId: "tc-1",
            state: "approval-responded",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            approval: { id: "ap-1", approved: true },
          },
        ] as unknown as AgentUIMessage["parts"],
      } as AgentUIMessage,
    ];

    await persistApprovedAssistantMessage("c1", "tc-1", inMemory);
    const after = await chatDb.getMessages("c1");
    // The `summary: true` flag survives the spread.
    expect(after[0].summary).toBe(true);
    // `createdAt` is preserved (no regeneration to Date.now()).
    expect(after[0].createdAt).toBe(100);
    // `parts` reflects the new approval-responded state.
    expect((after[0].parts[0] as { state: string }).state).toBe(
      "approval-responded",
    );
  });
});
