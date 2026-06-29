/**
 * Tests that `CompactingChatTransport` (fast path) and
 * `runWithRejectionLoop` thread the input messages through to the
 * SDK as `originalMessages` on `toUIMessageStream`. This is what
 * makes the SDK's built-in resume continuation work — see
 * `getResponseUIMessageId` in `ai/dist/index.mjs:5081-5090`: when the
 * last input message is an assistant, the SDK reuses its id for the
 * outbound stream's `start` chunk, converting an approval-resume into
 * a continuation of the existing assistant turn instead of a new
 * bubble.
 *
 * Without `originalMessages`, the SDK's `getResponseUIMessageId`
 * receives `originalMessages == null` and falls through to our
 * `generateMessageId` callback, which minted a fresh UUID on every
 * transport call — including resumes — and broke
 * `Chat.makeRequest`'s `replaceLastMessage` invariant
 * (`state.message.id === this.lastMessage.id`).
 *
 * These tests use a tiny `RejectionLoopAgent` stub whose
 * `toUIMessageStream` records the options it received, so we can
 * assert on the value of `originalMessages` directly.
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  CompactingChatTransport,
  runWithRejectionLoop,
  type RejectionLoopAgent,
} from "../compacting-transport";
import type { AgentUIMessage } from "../../types";

interface ToUIStreamOptions {
  originalMessages?: unknown;
  generateMessageId?: () => string;
}

function makeRecordingAgent(
  textChunks: string[],
): {
  agent: RejectionLoopAgent;
  /** Options observed across every `toUIMessageStream` call. */
  observed: ToUIStreamOptions[];
} {
  const observed: ToUIStreamOptions[] = [];
  const agent: RejectionLoopAgent = {
    tools: {},
    stream: async () => ({
      toUIMessageStream: (opts?: ToUIStreamOptions) => {
        observed.push(opts ?? {});
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            const id = "t-1";
            controller.enqueue({ type: "text-start", id } as never);
            for (const t of textChunks) {
              controller.enqueue({
                type: "text-delta",
                id,
                delta: t,
              } as never);
            }
            controller.enqueue({ type: "text-end", id } as never);
            controller.close();
          },
        });
      },
    }),
  };
  return { agent, observed };
}

function userMessage(text: string): AgentUIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

function assistantApprovalResponded(id: string): AgentUIMessage {
  return {
    id,
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
    ],
  } as AgentUIMessage;
}

async function drain(s: ReadableStream<UIMessageChunk>): Promise<void> {
  const reader = s.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("CompactingChatTransport (fast path) — originalMessages plumbing", () => {
  it("passes the validated input messages as `originalMessages` to toUIMessageStream", async () => {
    const { agent, observed } = makeRecordingAgent(["done"]);

    // CompactingChatTransport's constructor expects a full Agent shape.
    // RejectionLoopAgent is structurally compatible for the fast path
    // because the transport only calls `agent.stream(...).toUIMessageStream(...)`
    // there. Cast accordingly.
    const transport = new CompactingChatTransport({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
    });

    const inputs: AgentUIMessage[] = [
      userMessage("research keyboards"),
      assistantApprovalResponded("a-resume-target"),
    ];

    const stream = await transport.sendMessages({
      messages: inputs,
      // SDK transport signature requires these even though the fast
      // path doesn't read them.
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      abortSignal: undefined,
    } as Parameters<typeof transport.sendMessages>[0]);

    await drain(stream);

    expect(observed).toHaveLength(1);
    expect(observed[0].originalMessages).toBeDefined();

    // The SDK's `getResponseUIMessageId` only cares about the role of
    // the LAST message. Verify that's preserved as an assistant so
    // the resume-continuation branch (line 5089 of ai/index.mjs) fires.
    const om = observed[0].originalMessages as AgentUIMessage[];
    const last = om[om.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.id).toBe("a-resume-target");

    // `generateMessageId` is still wired so fresh-turn calls (last is
    // a user message) get a stable UUID. The SDK only uses it as a
    // fallback when the last message isn't an assistant.
    expect(typeof observed[0].generateMessageId).toBe("function");
  });

  it("still passes originalMessages when the last input is a user (fresh turn) — SDK selects generateMessageId on its side", async () => {
    const { agent, observed } = makeRecordingAgent(["hi"]);
    const transport = new CompactingChatTransport({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
    });

    const inputs: AgentUIMessage[] = [userMessage("hi")];

    const stream = await transport.sendMessages({
      messages: inputs,
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      abortSignal: undefined,
    } as Parameters<typeof transport.sendMessages>[0]);

    await drain(stream);

    expect(observed).toHaveLength(1);
    const om = observed[0].originalMessages as AgentUIMessage[];
    expect(om[om.length - 1].role).toBe("user");
  });
});

describe("runWithRejectionLoop — originalMessages plumbing", () => {
  it("passes the loop's current `messages` snapshot as `originalMessages` to each iteration", async () => {
    const { agent, observed } = makeRecordingAgent(["done"]);

    const inputs: AgentUIMessage[] = [
      userMessage("research keyboards"),
      assistantApprovalResponded("a-resume-target"),
    ];

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: inputs,
      sendMessagesAtCall: inputs,
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => undefined,
    });

    await drain(stream);

    // First iteration's stream observed.
    expect(observed.length).toBeGreaterThan(0);
    const firstIter = observed[0];
    const om = firstIter.originalMessages as AgentUIMessage[];
    expect(om).toBeDefined();
    expect(om[om.length - 1].role).toBe("assistant");
    expect(om[om.length - 1].id).toBe("a-resume-target");
  });
});
