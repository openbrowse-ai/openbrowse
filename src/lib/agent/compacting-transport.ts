import type {
  Agent,
  ChatTransport,
  ToolSet,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { DirectChatTransport } from "ai";
import type { CompactionPart, SerializedUIPart } from "../types";
import {
  COMPACTION_USER_PROMPT,
  prunePartsAtSendTime,
} from "./compaction";

interface Options {
  // Use `any` for the agent generics: the wrapper does not consume any of
  // the agent's per-call options, tool inferences, or output schema — it
  // only delegates `sendMessages`/`reconnectToStream` through to a
  // `DirectChatTransport` typed at the same UIMessage boundary the rest of
  // the codebase uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Agent<any, ToolSet, any>;
  /**
   * Called once at the top of each `sendMessages`. The agent layer uses
   * this to clear the per-stream "needs mid-stream compaction" signal so
   * the next step's onStepFinish can re-trigger it cleanly.
   */
  onSendStart?: () => void;
}

/**
 * A `ChatTransport` wrapper that applies auto-compaction at send time.
 *
 * Compaction events live as messages in the chat history (a user message
 * carrying a `CompactionPart`, immediately followed by an assistant
 * message containing the summary text). For every outbound request:
 *
 * 1. Walk the message list to find the latest completed compaction event
 *    (compaction-user immediately followed by an assistant whose first
 *    part-pair signature matches a summary). If found, drop the head and
 *    keep `[compaction-user, summary, ...retained-tail, ...post-event]`.
 *    The retained tail is anchored at `compactionPart.tailStartMessageId`
 *    when set; otherwise it falls back to "everything after the
 *    compaction event."
 * 2. Substitute the `CompactionPart` with a synthetic user text
 *    ("What did we do so far?") so the model sees a normal Q/A flow:
 *    user asks, assistant summarizes, user (auto-continue) says "continue
 *    where you left off."
 * 3. Apply per-part pruning (truncate oversized tool outputs, drop
 *    screenshot data) so even the live tail can't ship hundreds of KB of
 *    stale payload.
 * 4. Delegate the rewritten list to a `DirectChatTransport`.
 *
 * The Chat instance's in-memory messages are never mutated — the UI keeps
 * showing the full conversation; only what the LLM sees is compacted.
 *
 * If no compaction events exist, the wrapper still applies send-time
 * pruning (idempotent, near-zero overhead for short conversations).
 */
export class CompactingChatTransport implements ChatTransport<UIMessage> {
  private readonly inner: ChatTransport<UIMessage>;
  private readonly onSendStart?: () => void;

  constructor({ agent, onSendStart }: Options) {
    this.inner = new DirectChatTransport({
      agent,
    }) as unknown as ChatTransport<UIMessage>;
    this.onSendStart = onSendStart;
  }

  async sendMessages(
    args: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.onSendStart?.();
    const rewritten = rewriteForLLM(args.messages);
    return this.inner.sendMessages({ ...args, messages: rewritten });
  }

  reconnectToStream(
    args: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return this.inner.reconnectToStream(args);
  }
}

/**
 * Pure function: takes the chat's full UIMessage list and produces the
 * list to send to the model. Exported for testing and so other callers
 * (e.g. eventual `prepareStep` integrations) can share the logic.
 */
export function rewriteForLLM(messages: UIMessage[]): UIMessage[] {
  let working = messages;

  const event = findLatestCompactionEvent(messages);
  if (event) {
    const tailStartId = event.compactionPart.tailStartMessageId;
    const tailIdx = tailStartId
      ? messages.findIndex((m) => m.id === tailStartId)
      : -1;
    const retainedTailStart =
      tailIdx >= 0 && tailIdx < event.userIndex ? tailIdx : event.userIndex;

    working = [
      // The compaction-user marker — substituted to "What did we do so far?"
      // before sending (see substituteCompactionPart below).
      messages[event.userIndex],
      // The summary assistant message.
      messages[event.summaryIndex],
      // Retained tail (messages from tailStartMessageId up to but not
      // including the compaction-user).
      ...messages.slice(retainedTailStart, event.userIndex),
      // Everything after the summary (auto-continue + subsequent turns).
      ...messages.slice(event.summaryIndex + 1),
    ];
  }

  return working.map((m) => {
    let parts = m.parts as unknown as SerializedUIPart[];
    parts = substituteCompactionPart(parts);
    parts = prunePartsAtSendTime(parts);
    if (parts === (m.parts as unknown as SerializedUIPart[])) return m;
    return {
      ...m,
      parts: parts as unknown as UIMessage["parts"],
    };
  });
}

/**
 * Mirrors `findCompactionEvents` but operates on the SDK's UIMessage
 * (which does not carry our `summary: true` flag). We treat the assistant
 * message immediately following a user-with-CompactionPart as the summary.
 * Persistence layer guarantees this pairing exists once a compaction is
 * complete.
 */
function findLatestCompactionEvent(messages: UIMessage[]):
  | {
      userIndex: number;
      summaryIndex: number;
      compactionPart: CompactionPart;
    }
  | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const part = (m.parts as unknown as SerializedUIPart[]).find(
      (p): p is CompactionPart => p.type === "compaction",
    );
    if (!part) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant") continue;
    return { userIndex: i, summaryIndex: i + 1, compactionPart: part };
  }
  return undefined;
}

/**
 * Replaces any `CompactionPart` on a parts array with a synthetic text
 * part for the model. Returns the same reference when nothing changed.
 */
function substituteCompactionPart(
  parts: SerializedUIPart[],
): SerializedUIPart[] {
  let changed = false;
  const out: SerializedUIPart[] = [];
  for (const p of parts) {
    if (p.type === "compaction") {
      out.push({ type: "text", text: COMPACTION_USER_PROMPT });
      changed = true;
    } else {
      out.push(p);
    }
  }
  return changed ? out : parts;
}
