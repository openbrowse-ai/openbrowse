import type { UIMessage } from "ai";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: SerializedUIPart[];
  createdAt: number;
  /**
   * True for assistant messages that are an auto-compaction summary. The
   * compaction-user message that triggered this summary is the message
   * immediately preceding it (its `parts` contain a `CompactionPart`).
   *
   * Set on the assistant message instead of the user message because the
   * "completed compaction" predicate (used by `filterCompactedMessages`)
   * needs to know the summary is fully written; the assistant message's
   * presence + this flag is the natural signal.
   */
  summary?: boolean;
}

export type SerializedUIPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; mediaType: string; url: string }
  | { type: "source-url"; sourceId: string; url: string; title?: string }
  | { type: "step-start" }
  | CompactionPart
  | SerializedToolPart;

/**
 * Marker part that lives on a synthetic user message inserted into the chat
 * stream when the conversation is compacted. The next assistant message in
 * the stream carries the summary text (with `summary: true` on the message
 * record).
 *
 * - `auto`: true when triggered by the token threshold; false for manual
 *   `/compact` (follow-up).
 * - `overflow`: true when triggered by a context-overflow API error path.
 * - `tailStartMessageId`: id of the first message in the verbatim tail. The
 *   transport's `filterCompactedMessages` uses this to drop the head from
 *   the model view.
 */
export interface CompactionPart {
  type: "data-compaction";
  data: CompactionData;
}

export interface CompactionData {
  auto: boolean;
  overflow?: boolean;
  tailStartMessageId?: string;
}

/**
 * Custom `DATA_PARTS` map for our `UIMessage`. Keying `compaction` here
 * registers a `data-compaction` variant on `UIMessagePart<AgentDataParts, ...>`
 * with `data: CompactionData`. This is what lets us narrow on
 * `p.type === "data-compaction"` without any casts.
 *
 * The SDK type machinery generates the variant from this map; if you add a
 * new application-specific data part, add it here and the rest of the
 * codebase will pick it up via `AgentUIMessage`.
 */
export type AgentDataParts = {
  compaction: CompactionData;
};

/**
 * The `UIMessage` flavor we use throughout the app. The default `metadata`
 * generic (`unknown`) and tool generic (`UITools`) are kept; only the
 * `DATA_PARTS` slot is narrowed to our `AgentDataParts`.
 *
 * Component code, the chat hook, and the `CompactingChatTransport` all
 * type-check against this so the discriminated union of `parts` includes
 * `{ type: "data-compaction"; data: CompactionData; id?: string }`.
 */
export type AgentUIMessage = UIMessage<unknown, AgentDataParts>;

export interface SerializedToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}
