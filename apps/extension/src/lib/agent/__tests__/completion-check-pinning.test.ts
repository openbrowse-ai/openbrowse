/**
 * Verifies that the completion-check gate's view of conversationId is
 * pinned at `CompactingChatTransport.sendMessages` entry, not read
 * lazily mid-stream. The bug being prevented:
 *
 *   1. User sends a message in conversation A; agent loop starts.
 *   2. Mid-stream, user navigates to conversation B and the UI calls
 *      `setAgentContext('B')`.
 *   3. The post-iteration gate (`buildCompletionCheckInput`) used to
 *      read `agentConversationId` directly, so its chatDb todos lookup
 *      and telemetry routed to B instead of A.
 *
 * After the fix, the transport snapshots `getActiveConversationId()`
 * synchronously at the top of `sendMessages` and threads the snapshot
 * through to the gate as `pinnedConversationId`. The gate's closure
 * uses that value exclusively.
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { ToolSet, UIMessageChunk } from "ai";
import {
  CompactingChatTransport,
  runWithRejectionLoop,
  type RejectionLoopAgent,
} from "../compacting-transport";
import type { AgentUIMessage } from "../../types";

function userMessage(text: string): AgentUIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

function makeStubAgent(text: string): RejectionLoopAgent {
  return {
    tools: {},
    stream: async () => {
      const id = "m-1";
      return {
        toUIMessageStream: () =>
          new ReadableStream<UIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "text-start", id } as never);
              controller.enqueue({
                type: "text-delta",
                id,
                delta: text,
              } as never);
              controller.enqueue({ type: "text-end", id } as never);
              controller.close();
            },
          }),
      };
    },
  };
}

async function drainStream(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return chunks;
}

describe("runWithRejectionLoop — pinnedConversationId", () => {
  it("forwards pinnedConversationId verbatim to buildCompletionCheckInput", async () => {
    const observed: { pinnedConversationId: string | null }[] = [];
    const stream = runWithRejectionLoop({
      agent: makeStubAgent("done."),
      validatedMessages: [userMessage("hi")],
      sendMessagesAtCall: [userMessage("hi")],
      abortSignal: undefined,
      pinnedConversationId: "conv-A",
      buildCompletionCheckInput: ({ pinnedConversationId }) => {
        observed.push({ pinnedConversationId });
        // Returning undefined makes the loop exit after the first
        // iteration without invoking the gate model — sufficient for
        // proving the cid was threaded through.
        return undefined;
      },
    });
    await drainStream(stream);

    expect(observed).toEqual([{ pinnedConversationId: "conv-A" }]);
  });

  it("forwards null pinnedConversationId unchanged", async () => {
    const observed: { pinnedConversationId: string | null }[] = [];
    const stream = runWithRejectionLoop({
      agent: makeStubAgent("done."),
      validatedMessages: [userMessage("hi")],
      sendMessagesAtCall: [userMessage("hi")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: ({ pinnedConversationId }) => {
        observed.push({ pinnedConversationId });
        return undefined;
      },
    });
    await drainStream(stream);

    expect(observed).toEqual([{ pinnedConversationId: null }]);
  });
});

describe("CompactingChatTransport — pinning at sendMessages entry", () => {
  /**
   * Build a minimal `Agent<never, ToolSet, never>` stub. Type assertion
   * is necessary because the SDK's full Agent class has many private
   * fields the test doesn't need.
   */
  function makeAgent(text: string): unknown {
    return {
      tools: {} satisfies ToolSet,
      stream: async () => ({
        toUIMessageStream: () =>
          new ReadableStream<UIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "m1" } as never);
              controller.enqueue({
                type: "text-delta",
                id: "m1",
                delta: text,
              } as never);
              controller.enqueue({ type: "text-end", id: "m1" } as never);
              controller.close();
            },
          }),
      }),
    };
  }

  it("captures cid synchronously at sendMessages entry, even if the getter changes after", async () => {
    let activeCid: string | null = "conv-A";
    const observed: (string | null)[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new CompactingChatTransport({
      agent: makeAgent("answer.") as any,
      getActiveConversationId: () => activeCid,
      buildCompletionCheckInput: ({ pinnedConversationId }) => {
        observed.push(pinnedConversationId);
        return undefined;
      },
    });

    // Begin sending. The transport reads the getter once at entry; the
    // returned ReadableStream is consumed below.
    const streamPromise = transport.sendMessages({
      messages: [userMessage("Q")],
      abortSignal: undefined,
      // Cast: SDK has additional optional params we don't need here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Flip the source-of-truth between sendMessages entry and the gate.
    // The gate fires after the agent's iteration emits its final-text
    // chunks; the rejection-loop body isn't synchronous with sendMessages
    // entry, so the transport must have already pinned by now.
    activeCid = "conv-B";

    const stream = await streamPromise;
    await drainStream(stream);

    // Even though the getter is now returning B, the gate should have
    // received A — the value at sendMessages entry.
    expect(observed).toEqual(["conv-A"]);
  });

  it("captures null when getActiveConversationId is not provided", async () => {
    const observed: (string | null)[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new CompactingChatTransport({
      agent: makeAgent("answer.") as any,
      // getActiveConversationId omitted on purpose.
      buildCompletionCheckInput: ({ pinnedConversationId }) => {
        observed.push(pinnedConversationId);
        return undefined;
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await transport.sendMessages({
      messages: [userMessage("Q")],
      abortSignal: undefined,
    } as any);
    await drainStream(stream);

    expect(observed).toEqual([null]);
  });
});
