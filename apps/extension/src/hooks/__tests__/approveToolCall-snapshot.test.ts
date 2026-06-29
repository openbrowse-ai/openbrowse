/**
 * Tests for `applyApprovalResponseToMessages` + `handleApprovalClick`.
 *
 * `applyApprovalResponseToMessages` is a pure transform that mirrors
 * the AI SDK's `Chat.addToolApprovalResponse` mutation locally so the
 * orchestration layer (`approveToolCall`) can take a post-click
 * snapshot of the messages array synchronously, without racing React's
 * commit cycle.
 *
 * `handleApprovalClick` wires the transform up to the persist call and
 * the SDK notify call. The orchestration test below pins the contract
 * the reviewer asked for: `persistApprovedAssistantMessage` MUST
 * receive the post-click snapshot (state `approval-responded`), NOT
 * the pre-click messages array (state `approval-requested`).
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyApprovalResponseToMessages,
  handleApprovalClick,
  type ApprovalClickDeps,
} from "../useAgentChat";
import type { AgentUIMessage } from "@/lib/types";

function assistantWithApprovalRequested(
  id: string,
  toolCallId: string,
  approvalId: string,
): AgentUIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "proposePlan",
        toolCallId,
        state: "approval-requested",
        input: { goal: "g", sites: [], todos: [], allowNetwork: false },
        approval: { id: approvalId },
      },
    ] as unknown as AgentUIMessage["parts"],
  } as AgentUIMessage;
}

function userMessage(id: string, text: string): AgentUIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

describe("applyApprovalResponseToMessages", () => {
  it("flips the matching approval-requested part on the trailing assistant to approval-responded", () => {
    const messages: AgentUIMessage[] = [
      userMessage("u1", "go"),
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];

    const out = applyApprovalResponseToMessages(messages, {
      id: "ap-1",
      approved: true,
    });

    expect(out.mutatedMessageId).toBe("a1");
    const a1 = out.messages[1];
    const part = a1.parts[0] as {
      state: string;
      approval?: { id?: string; approved?: boolean; reason?: string };
    };
    expect(part.state).toBe("approval-responded");
    expect(part.approval).toMatchObject({ id: "ap-1", approved: true });
    // Reason is not added when not provided.
    expect(part.approval?.reason).toBeUndefined();
  });

  it("flips with approved=false for denial", () => {
    const messages: AgentUIMessage[] = [
      userMessage("u1", "go"),
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];

    const out = applyApprovalResponseToMessages(messages, {
      id: "ap-1",
      approved: false,
    });

    expect(out.mutatedMessageId).toBe("a1");
    const part = out.messages[1].parts[0] as {
      state: string;
      approval?: { approved?: boolean };
    };
    expect(part.state).toBe("approval-responded");
    expect(part.approval?.approved).toBe(false);
  });

  it("carries through a reason when provided", () => {
    const messages: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];

    const out = applyApprovalResponseToMessages(messages, {
      id: "ap-1",
      approved: false,
      reason: "user-typed reason",
    });

    const part = out.messages[0].parts[0] as {
      approval?: { reason?: string };
    };
    expect(part.approval?.reason).toBe("user-typed reason");
  });

  it("returns mutatedMessageId=null when the trailing message is a user", () => {
    // The SDK only ever applies addToolApprovalResponse to the last
    // message; replicate that exactly. If the user submitted a new
    // turn before clicking the (now stale) approval card, the trailing
    // message is the user's new prompt — leave it alone.
    const messages: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
      userMessage("u2", "actually, do something else"),
    ];

    const out = applyApprovalResponseToMessages(messages, {
      id: "ap-1",
      approved: true,
    });

    expect(out.mutatedMessageId).toBeNull();
    // a1's part is unchanged.
    const part = out.messages[0].parts[0] as { state: string };
    expect(part.state).toBe("approval-requested");
  });

  it("returns mutatedMessageId=null when approval.id does not match any part on the trailing assistant", () => {
    const messages: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];

    const out = applyApprovalResponseToMessages(messages, {
      id: "stale-approval-id",
      approved: true,
    });

    expect(out.mutatedMessageId).toBeNull();
    const part = out.messages[0].parts[0] as { state: string };
    expect(part.state).toBe("approval-requested");
  });

  it("does NOT mutate an earlier assistant that happens to hold a matching approval.id", () => {
    // Defensive: mirrors the SDK's "only the last message" rule. If
    // history contains a stale approval-requested part with the same
    // id (e.g. user reloaded a long transcript, ids collide), we still
    // only touch the trailing assistant.
    const messages: AgentUIMessage[] = [
      assistantWithApprovalRequested("a-old", "tc-old", "ap-1"),
      userMessage("u2", "another turn"),
      assistantWithApprovalRequested("a-current", "tc-new", "ap-1"),
    ];

    const out = applyApprovalResponseToMessages(messages, {
      id: "ap-1",
      approved: true,
    });

    expect(out.mutatedMessageId).toBe("a-current");
    // Earlier assistant is structurally unchanged.
    expect(out.messages[0]).toBe(messages[0]);
    const oldPart = out.messages[0].parts[0] as { state: string };
    expect(oldPart.state).toBe("approval-requested");
    // Newer assistant's part flipped.
    const newPart = out.messages[2].parts[0] as { state: string };
    expect(newPart.state).toBe("approval-responded");
  });

  it("returns mutatedMessageId=null for an empty messages array", () => {
    const out = applyApprovalResponseToMessages([], {
      id: "ap-1",
      approved: true,
    });
    expect(out.mutatedMessageId).toBeNull();
    expect(out.messages).toEqual([]);
  });

  it("does not mutate the input messages array (immutability)", () => {
    const messages: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];
    const before = JSON.parse(JSON.stringify(messages));

    applyApprovalResponseToMessages(messages, { id: "ap-1", approved: true });

    expect(messages).toEqual(before);
  });
});

describe("handleApprovalClick — orchestration contract", () => {
  it("passes the POST-click snapshot to persist, not the pre-click array", async () => {
    // The reviewer-pinned regression: under the previous
    // implementation, `approveToolCall` called
    // `addToolApprovalResponse` first and then read
    // `messagesRef.current` after `await Promise.resolve()`. That
    // raced React's commit cycle — the ref might still hold the
    // pre-click messages (with the part in `approval-requested`) when
    // we passed it to `persistApprovedAssistantMessage`, making the
    // whole reload-race fix a no-op.
    //
    // The new flow computes the post-click snapshot LOCALLY via
    // `applyApprovalResponseToMessages` BEFORE involving the SDK, so
    // the persist call always receives the correctly-flipped messages
    // regardless of what React has or hasn't committed.
    const preClick: AgentUIMessage[] = [
      userMessage("u1", "go"),
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];

    let persistedMessages: ReadonlyArray<AgentUIMessage> | null = null;
    const persist = vi.fn(
      async (
        _cid: string,
        _toolCallId: string,
        msgs: ReadonlyArray<AgentUIMessage>,
      ) => {
        persistedMessages = msgs;
        return "a1";
      },
    );

    let sdkNotified = false;
    const notifySdk = vi.fn((opts: { id: string; approved: boolean }) => {
      // Assertion captured at notify time: persist MUST have been
      // called already and MUST have received the post-click snapshot.
      // The pre-click array would have had `approval-requested`.
      sdkNotified = true;
      expect(opts).toEqual({ id: "ap-1", approved: true });
      expect(persistedMessages).not.toBeNull();
      const a1 = persistedMessages![1];
      const part = a1.parts[0] as { state: string };
      expect(part.state).toBe("approval-responded");
    });

    const deps: ApprovalClickDeps = {
      conversationId: "c1",
      messages: preClick,
      persist,
      notifySdk,
    };

    await handleApprovalClick({ id: "ap-1", approved: true }, deps);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(notifySdk).toHaveBeenCalledTimes(1);
    expect(sdkNotified).toBe(true);

    // The captured snapshot is the post-click state.
    expect(persistedMessages).not.toBeNull();
    const persistedAssistant = persistedMessages![1];
    const persistedPart = persistedAssistant.parts[0] as {
      state: string;
      approval?: { id: string; approved: boolean };
    };
    expect(persistedPart.state).toBe("approval-responded");
    expect(persistedPart.approval).toMatchObject({
      id: "ap-1",
      approved: true,
    });

    // The pre-click array is unchanged (proves the helper didn't
    // mutate `deps.messages` in place).
    const preClickPart = preClick[1].parts[0] as { state: string };
    expect(preClickPart.state).toBe("approval-requested");
  });

  it("persists BEFORE notifying the SDK (ordering invariant)", async () => {
    // The persist must land before the SDK resume kicks off so a
    // reload between the click and the resume's first chunk doesn't
    // see chat-db's pre-click state.
    const calls: string[] = [];
    const preClick: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];

    const deps: ApprovalClickDeps = {
      conversationId: "c1",
      messages: preClick,
      persist: async () => {
        calls.push("persist");
        return "a1";
      },
      notifySdk: () => {
        calls.push("notifySdk");
      },
    };

    await handleApprovalClick({ id: "ap-1", approved: true }, deps);
    expect(calls).toEqual(["persist", "notifySdk"]);
  });

  it("skips persist when there is no matching approval-requested part (stale toolCallId), but still notifies the SDK", async () => {
    // Defense in depth: if the part was already flipped (double-click,
    // race), we should still hand the SDK its mutation so its
    // idempotency handles the no-op. Persisting an already-flipped
    // message is wasteful but harmless; skipping it is the contract.
    const preClick: AgentUIMessage[] = [
      userMessage("u1", "no assistant yet"),
    ];

    const persist = vi.fn();
    const notifySdk = vi.fn();

    await handleApprovalClick(
      { id: "ap-1", approved: true },
      {
        conversationId: "c1",
        messages: preClick,
        persist,
        notifySdk,
      },
    );

    expect(persist).not.toHaveBeenCalled();
    expect(notifySdk).toHaveBeenCalledWith({ id: "ap-1", approved: true });
  });

  it("skips persist when conversationId is null but still notifies the SDK", async () => {
    const preClick: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];
    const persist = vi.fn();
    const notifySdk = vi.fn();

    await handleApprovalClick(
      { id: "ap-1", approved: true },
      {
        conversationId: null,
        messages: preClick,
        persist,
        notifySdk,
      },
    );

    expect(persist).not.toHaveBeenCalled();
    expect(notifySdk).toHaveBeenCalled();
  });

  it("notifies the SDK even when persist throws (the approve click must never appear to fail)", async () => {
    const preClick: AgentUIMessage[] = [
      assistantWithApprovalRequested("a1", "tc-1", "ap-1"),
    ];
    const persist = vi.fn(async () => {
      throw new Error("chatDb offline");
    });
    const notifySdk = vi.fn();

    // Silence the console.warn the production path emits on persist
    // failure so the test output stays clean.
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await handleApprovalClick(
      { id: "ap-1", approved: true },
      {
        conversationId: "c1",
        messages: preClick,
        persist,
        notifySdk,
      },
    );

    expect(persist).toHaveBeenCalledTimes(1);
    expect(notifySdk).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
