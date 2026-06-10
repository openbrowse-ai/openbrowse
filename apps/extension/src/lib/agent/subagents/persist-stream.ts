/**
 * Persist a subagent's UIMessage stream into chat-db under a child
 * conversation id. Used by `peer` and `incognito` isolation paths in
 * the runner so that "Open child →" navigates to a conversation with
 * the subagent's full transcript rendered by the existing chat UI.
 *
 * Inline isolation does NOT call `persistAssistantStream` — its
 * messages would interleave with the parent's chat in confusing ways.
 * Inline runs use `consumeAssistantStream` instead, which collects the
 * transcript without writing to chat-db; the transcript flows back to
 * the parent's `DelegateResult` block via `SubagentRunResult.transcript`.
 *
 * Persistence semantics (peer / incognito):
 *  - One synthetic user message saved up front (`persistDelegationMessage`)
 *    so the user can see the task spec the subagent received.
 *  - Streamed assistant messages are saved by id; the SDK emits the
 *    same id with growing parts as the run progresses, so `saveMessage`
 *    upserts naturally.
 *  - Empty / step-start-only messages are skipped (matches the parent
 *    transport's `hasMeaningfulContent` policy).
 *  - On stream error, whatever was persisted up to that point survives —
 *    no rollback. The runner records the failure status separately.
 */

import { chatDb } from "../../chat-db";
import type { AgentUIMessage } from "../../types";
import {
  extractTextContent,
  hasMeaningfulContent,
  serializeParts,
} from "../serialize-parts";
import type { SerializedAssistantMessage } from "./types";

export interface AssistantStreamSink {
  /** Conversation id to persist all messages under (the child's id). */
  childConversationId: string;
  /**
   * AsyncIterable of UIMessages. Typically produced by `readUIMessageStream`
   * over the SDK's `subagent.stream(...).toUIMessageStream()`.
   */
  uiMessages: AsyncIterable<AgentUIMessage>;
  /** Callback invoked with the accumulated text on each tick. */
  onSummary?: (text: string) => void;
}

export interface AssistantStreamResult {
  /** The last text content seen — used as the subagent's summary. */
  finalText: string;
  /** Number of distinct messages persisted/captured (excludes skipped empties). */
  messageCount: number;
  /**
   * Per-message transcript. One entry per distinct message id, with
   * parts reflecting the FINAL state at end-of-stream. Suitable for
   * round-tripping through `SubagentRunResult.transcript` to render
   * inline in `DelegateResult`.
   */
  transcript: SerializedAssistantMessage[];
}

export type PersistAssistantStreamOptions = AssistantStreamSink;

/**
 * Save the synthesized delegation prompt as the first user message in
 * the child conversation. Returns the assigned message id.
 */
export async function persistDelegationMessage(
  childConversationId: string,
  userMessage: string,
): Promise<string> {
  const id = `delegation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await chatDb.saveMessage({
    id,
    conversationId: childConversationId,
    role: "user",
    content: userMessage,
    parts: [{ type: "text", text: userMessage }],
    createdAt: Date.now(),
  });
  return id;
}

/**
 * Stateful, incremental persister for a subagent's assistant messages.
 *
 * Both the streaming path (`persistAssistantStream`) and live, message-at-a-
 * time callers (e.g. the CUA loop's `onUiMessage`) use this so a single
 * message-handling implementation governs dedup-by-id, ordering, the
 * "meaningful content" filter, and chat-db upserts. Persisting each message
 * as it arrives is what makes the subagent's trace render in REAL TIME in
 * the parent's DelegateResult block.
 */
export class AssistantStreamPersister {
  private readonly transcriptIndexById = new Map<string, number>();
  private readonly transcript: SerializedAssistantMessage[] = [];
  private readonly createdAtById = new Map<string, number>();
  private lastText = "";

  constructor(
    private readonly childConversationId: string,
    private readonly onSummary?: (text: string) => void,
  ) {}

  /** Persist one UIMessage (upsert by id). Safe to call repeatedly with the
   *  same id as the SDK streams growing parts. Skips non-assistant / empty. */
  async persist(message: AgentUIMessage): Promise<void> {
    if (message.role !== "assistant") return;

    const parts = serializeParts(message.parts);
    if (!hasMeaningfulContent(parts)) return;

    const text = extractTextContent(parts);
    let createdAt = this.createdAtById.get(message.id);
    if (createdAt === undefined) {
      createdAt = Date.now();
      this.createdAtById.set(message.id, createdAt);
    }

    const existingIdx = this.transcriptIndexById.get(message.id);
    if (existingIdx === undefined) {
      this.transcriptIndexById.set(message.id, this.transcript.length);
      this.transcript.push({ id: message.id, parts });
    } else {
      this.transcript[existingIdx] = { id: message.id, parts };
    }

    await chatDb.saveMessage({
      id: message.id,
      conversationId: this.childConversationId,
      role: "assistant",
      content: text,
      parts,
      createdAt,
    });

    this.lastText = text;
    this.onSummary?.(text);
  }

  result(): AssistantStreamResult {
    return {
      finalText: this.lastText,
      messageCount: this.transcriptIndexById.size,
      transcript: this.transcript,
    };
  }
}

/**
 * Consume a UIMessage stream and persist each meaningful update under
 * the child conversation. Returns the accumulated transcript +
 * final text + count.
 */
export async function persistAssistantStream(
  opts: PersistAssistantStreamOptions,
): Promise<AssistantStreamResult> {
  const { childConversationId, uiMessages, onSummary } = opts;
  const persister = new AssistantStreamPersister(childConversationId, onSummary);

  for await (const message of uiMessages) {
    await persister.persist(message);
  }

  return persister.result();
}
