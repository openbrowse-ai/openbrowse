import {
  convertToModelMessages,
  validateUIMessages,
  type Agent,
  type ChatTransport,
  type InferUITools,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { AgentDataParts, AgentUIMessage, CompactionPart } from "../types";
import { COMPACTION_USER_PROMPT, prunePartsAtSendTime } from "./compaction";

interface Options<TOOLS extends ToolSet> {
  agent: Agent<never, TOOLS, never>;
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
 * 4. We skip `DirectChatTransport` and manually convert and stream via the
 *    underlying Agent. `DirectChatTransport`'s class signature constrains
 *    `UI_MESSAGE extends UIMessage<unknown, never, ...>` — i.e. forbids any
 *    extended `DATA_PARTS` — which would reject our `AgentDataParts`.
 *    Inlining the four-line equivalent (validate → convert → stream →
 *    toUIMessageStream) lets us flow `AgentUIMessage` end-to-end without
 *    type assertions.
 *
 * The Chat instance's in-memory messages are never mutated — the UI keeps
 * showing the full conversation; only what the LLM sees is compacted.
 *
 * If no compaction events exist, the wrapper still applies send-time
 * pruning (idempotent, near-zero overhead for short conversations).
 *
 * @typeParam TOOLS - The agent's tool set; flows through to
 *   `validateUIMessages` so tool-call shapes are validated against the
 *   agent's actual tools at the type level. Mirrors `DirectChatTransport`'s
 *   `TOOLS` parameter.
 */
export class CompactingChatTransport<TOOLS extends ToolSet = ToolSet>
  implements ChatTransport<AgentUIMessage>
{
  private readonly agent: Agent<never, TOOLS, never>;
  private readonly onSendStart?: () => void;

  constructor({ agent, onSendStart }: Options<TOOLS>) {
    this.agent = agent;
    this.onSendStart = onSendStart;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<AgentUIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    this.onSendStart?.();
    const rewritten = rewriteForLLM(messages);

    // Tie validateUIMessages' inferred UI_MESSAGE to *this transport's*
    // TOOLS so its `tools` parameter resolves to the same shape as
    // `agent.tools` (i.e. the precise tools the agent was constructed
    // with). Without this hint TS defaults to the wide `UITools` map and
    // rejects the assignment.
    type ToolBoundUIMessage = UIMessage<
      unknown,
      AgentDataParts,
      InferUITools<TOOLS>
    >;
    const validatedMessages = await validateUIMessages<ToolBoundUIMessage>({
      messages: rewritten,
      tools: this.agent.tools,
    });

    const modelMessages = await convertToModelMessages(validatedMessages, {
      tools: this.agent.tools,
    });

    const result = await this.agent.stream({
      prompt: modelMessages,
      abortSignal,
    });

    return result.toUIMessageStream();
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // Reconnection is not supported for in-process direct agent transport.
    return Promise.resolve(null);
  }
}

/**
 * Pure function: takes the chat's full UIMessage list and produces the
 * list to send to the model. Exported for testing and so other callers
 * (e.g. eventual `prepareStep` integrations) can share the logic.
 *
 * Operates on `AgentUIMessage` directly — its `DATA_PARTS = AgentDataParts`
 * gives us a real `data-compaction` variant in the parts union, so all the
 * helpers below narrow on `p.type === "data-compaction"` without casts.
 */
export function rewriteForLLM(messages: AgentUIMessage[]): AgentUIMessage[] {
  // Step 1: repair legacy broken compaction events. An earlier version of
  // `runCompaction` had a "prune-only fast path" that wrote a compaction
  // event with an empty summary assistant. Sending that message fails the
  // AI SDK's Zod validation ("Message must contain at least one part").
  // We detect those broken events (compaction-user immediately followed
  // by an assistant with no parts) and excise the whole event — the
  // user-with-CompactionPart, the empty summary, and any adjacent
  // synthetic auto-continue user that followed. Stale-data only; new code
  // never produces this shape.
  const repaired = excludeBrokenCompactionEvents(messages);
  let working = repaired;

  const event = findLatestCompactionEvent(repaired);
  if (event) {
    const tailStartId = event.compactionPart.data.tailStartMessageId;
    const tailIdx = tailStartId
      ? repaired.findIndex((m) => m.id === tailStartId)
      : -1;
    const retainedTailStart =
      tailIdx >= 0 && tailIdx < event.userIndex ? tailIdx : event.userIndex;

    working = [
      // The compaction-user marker — substituted to "What did we do so far?"
      // before sending (see substituteCompactionPart below).
      repaired[event.userIndex],
      // The summary assistant message.
      repaired[event.summaryIndex],
      // Retained tail (messages from tailStartMessageId up to but not
      // including the compaction-user).
      ...repaired.slice(retainedTailStart, event.userIndex),
      // Everything after the summary (auto-continue + subsequent turns).
      ...repaired.slice(event.summaryIndex + 1),
    ];
  }

  const rewritten = working.map((m) => {
    let parts = m.parts;
    parts = substituteCompactionPart(parts);
    parts = prunePartsAtSendTime(parts);
    if (parts === m.parts) return m;
    return { ...m, parts };
  });

  // Final safety net: drop any message that still ended up with empty
  // parts after substitution + pruning. Should be unreachable now that
  // `excludeBrokenCompactionEvents` runs first, but cheap insurance.
  return rewritten.filter((m) => m.parts.length > 0);
}

/**
 * Removes broken auto-compaction events (compaction-user immediately
 * followed by an assistant with no parts). Also strips the synthetic
 * auto-continue user message that typically follows the broken pair, to
 * avoid leaving the conversation with adjacent user messages that
 * Anthropic rejects.
 *
 * The "Continue where you left off..." text is the canonical auto-continue
 * sentinel; we match by exact prefix to keep the heuristic conservative.
 */
const AUTO_CONTINUE_PREFIX = "Continue where you left off";

function excludeBrokenCompactionEvents(
  messages: AgentUIMessage[],
): AgentUIMessage[] {
  const skipIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const hasCompactionPart = m.parts.some(
      (p) => p.type === "data-compaction",
    );
    if (!hasCompactionPart) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant") continue;
    if (next.parts.length > 0) continue;

    skipIds.add(m.id);
    skipIds.add(next.id);

    const after = messages[i + 2];
    if (after && after.role === "user") {
      const text = after.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text.startsWith(AUTO_CONTINUE_PREFIX)) {
        skipIds.add(after.id);
      }
    }
  }

  if (skipIds.size === 0) return messages;
  return messages.filter((m) => !skipIds.has(m.id));
}

/**
 * Mirrors `findCompactionEvents` but operates on the SDK's UIMessage
 * (which does not carry our `summary: true` flag). We treat the assistant
 * message immediately following a user-with-CompactionPart as the summary.
 * Persistence layer guarantees this pairing exists once a compaction is
 * complete.
 */
function findLatestCompactionEvent(messages: AgentUIMessage[]):
  | {
      userIndex: number;
      summaryIndex: number;
      compactionPart: CompactionPart;
    }
  | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    // `find` narrows `part` to the data-compaction variant of
    // `UIMessagePart<AgentDataParts, ...>`, which is structurally
    // identical to `CompactionPart`.
    const part = m.parts.find((p) => p.type === "data-compaction");
    if (!part) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant") continue;
    return {
      userIndex: i,
      summaryIndex: i + 1,
      compactionPart: part,
    };
  }
  return undefined;
}

/**
 * Replaces any `CompactionPart` on a parts array with a synthetic text
 * part for the model. Returns the same reference when nothing changed.
 */
function substituteCompactionPart(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  let changed = false;
  const out: AgentUIMessage["parts"] = [];
  for (const p of parts) {
    if (p.type === "data-compaction") {
      // TextUIPart is a member of `AgentUIMessage["parts"][number]`, so
      // pushing it widens to the union with no cast.
      out.push({ type: "text", text: COMPACTION_USER_PROMPT });
      changed = true;
    } else {
      out.push(p);
    }
  }
  return changed ? out : parts;
}
