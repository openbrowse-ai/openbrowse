// src/lib/agent/compaction.ts
import type {
  AgentUIMessage,
  ChatMessage,
  CompactionPart,
  SerializedUIPart,
} from "../types";
import type { ModelDefinition } from "@/registry/providers/types";

// Constants
export const COMPACTION_BUFFER = 20_000;
export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
export const TOOL_OUTPUT_MAX_CHARS = 2_000;
export const PROTECTED_TURNS = 2;
export const TAIL_TURNS = 2;
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;
export const MAX_PRESERVE_RECENT_TOKENS = 8_000;
export const MIN_MESSAGES_FOR_COMPACTION = 4;
/**
 * Time-based debounce for thrash detection. If the latest completed
 * compaction in the conversation finished less than this many milliseconds
 * ago, skip running another compaction. This prevents the
 * compaction-summarizes-but-summary-still-overflows infinite loop without
 * keeping a hidden attempts counter.
 *
 * 30s is a sane default — covers a runaway summary cycle but doesn't block
 * a genuinely long agent run that crosses the threshold a second time.
 */
export const COMPACTION_DEBOUNCE_MS = 30_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_000;

const COMPACTION_SYSTEM_PROMPT = `You are a context summarization assistant for a browser agent session.

Summarize only the conversation history you are given. The newest turns are kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, update it: preserve still-true details, remove stale details, merge in new facts.

Follow the exact output structure requested. Use terse bullets. Preserve exact URLs, element selectors, error messages, and data values. Do not mention the summary process. Respond in the same language as the conversation.`;

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown below. Keep every section, even when empty.

## Goal
- [what the user is trying to accomplish]

## Plan
- [current todo list state and progress, if any plan was created]

## Pages & Context
- [url]: [what was learned/done there]

## Progress
- [completed actions or "(none)"]

## Key Findings
- [important facts, data, answers]

## Next Steps
- [what to do next or "(none)"]

Rules:
- Use terse bullets, not prose paragraphs.
- Preserve exact URLs, CSS selectors, element text, error strings, and data values.
- Do not mention compaction or summarization.`;

// Token Estimation Functions

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(parts: SerializedUIPart[]): number {
  let total = 0;

  for (const part of parts) {
    if (part.type === "text") {
      total += estimateTokens(part.text);
    } else if (part.type === "reasoning") {
      total += estimateTokens(part.text);
    } else if (part.type === "dynamic-tool") {
      // Estimate input size
      if (part.input !== undefined) {
        total += estimateTokens(JSON.stringify(part.input));
      }
      // Estimate output size
      if (part.output !== undefined) {
        total += estimateTokens(
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output)
        );
      }
    } else if (part.type === "file") {
      total += estimateTokens(part.url);
    } else {
      // Default for other types
      total += 10;
    }
  }

  return total;
}

export function getUsableTokens(model: ModelDefinition | undefined): number {
  const context = model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutput = model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT;
  return context - maxOutput - COMPACTION_BUFFER;
}

export function shouldCompact(
  totalTokens: number,
  model: ModelDefinition | undefined
): boolean {
  return totalTokens >= getUsableTokens(model);
}

// Pruning (Phase 1)

export interface PrunableMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: SerializedUIPart[];
  createdAt: number;
}

/**
 * Per-message-part pruner used by the compacting transport at send time.
 *
 * Differs from `pruneMessages`:
 * - Operates on a single message's `parts` (no protected-tail logic — the
 *   transport already preserves the verbatim tail above this layer).
 * - Always trims oversized tool outputs (no `PRUNE_PROTECT` cumulative budget
 *   — that gates the *decision* to compact in `runCompaction`, not what we
 *   send to the model).
 * - Idempotent — running it twice produces identical output.
 *
 * Returns the same array reference when nothing changed (cheap fast-path for
 * messages with no large outputs).
 *
 * Operates on the SDK's `UIMessagePart` union directly via
 * `AgentUIMessage["parts"]` so callers (the transport) don't have to
 * convert to/from our `SerializedUIPart` shape. Only `dynamic-tool` parts
 * are inspected; everything else passes through unchanged.
 */
export function prunePartsAtSendTime(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  let changed = false;
  const out: AgentUIMessage["parts"] = [];

  for (const part of parts) {
    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      out.push(part);
      continue;
    }

    const outputStr =
      typeof part.output === "string"
        ? part.output
        : JSON.stringify(part.output);

    if (
      part.toolName === "screenshot" ||
      part.toolName === "screenshotPage"
    ) {
      out.push({ ...part, output: "[screenshot removed during compaction]" });
      changed = true;
      continue;
    }

    if (outputStr.length > TOOL_OUTPUT_MAX_CHARS) {
      out.push({
        ...part,
        output: outputStr.substring(0, TOOL_OUTPUT_MAX_CHARS) + "...",
      });
      changed = true;
      continue;
    }

    out.push(part);
  }

  return changed ? out : parts;
}

export function pruneMessages(
  messages: PrunableMessage[]
): { pruned: PrunableMessage[]; freedTokens: number } {
  // Return unchanged if fewer than minimum messages
  if (messages.length < MIN_MESSAGES_FOR_COMPACTION) {
    return { pruned: messages, freedTokens: 0 };
  }

  // Find protected tail (last PROTECTED_TURNS user turns and everything after)
  let userTurnsSeen = 0;
  let tailStartIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen > PROTECTED_TURNS) {
        tailStartIndex = i + 1;
        break;
      }
    }
  }

  let freedTokens = 0;
  let cumulativeToolOutputTokens = 0;
  const pruned: PrunableMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Don't prune protected tail
    if (i >= tailStartIndex) {
      pruned.push(message);
      continue;
    }

    // Process message parts
    const newParts: SerializedUIPart[] = [];
    let messageChanged = false;

    for (const part of message.parts) {
      if (
        part.type === "dynamic-tool" &&
        part.state === "output-available" &&
        part.output !== undefined
      ) {
        const outputStr =
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output);
        const outputTokens = estimateTokens(outputStr);

        cumulativeToolOutputTokens += outputTokens;

        // Protect the first PRUNE_PROTECT tokens worth
        if (cumulativeToolOutputTokens <= PRUNE_PROTECT) {
          newParts.push(part);
          continue;
        }

        // Beyond threshold, start pruning
        // Check if this is a screenshot tool
        if (
          part.toolName === "screenshot" ||
          part.toolName === "screenshotPage"
        ) {
          // Replace output with placeholder
          newParts.push({
            ...part,
            output: "[screenshot removed during compaction]",
          });
          freedTokens += outputTokens - estimateTokens("[screenshot removed during compaction]");
          messageChanged = true;
        } else if (outputStr.length > TOOL_OUTPUT_MAX_CHARS) {
          // Truncate long outputs
          const truncated = outputStr.substring(0, TOOL_OUTPUT_MAX_CHARS) + "...";
          newParts.push({
            ...part,
            output: truncated,
          });
          freedTokens += outputTokens - estimateTokens(truncated);
          messageChanged = true;
        } else {
          newParts.push(part);
        }
      } else {
        newParts.push(part);
      }
    }

    pruned.push(messageChanged ? { ...message, parts: newParts } : message);
  }

  // Only return pruned messages if we freed enough tokens
  if (freedTokens > PRUNE_MINIMUM) {
    return { pruned, freedTokens };
  }

  return { pruned: messages, freedTokens: 0 };
}

// Tail Selection

export function selectTail(
  messages: PrunableMessage[],
  model: ModelDefinition | undefined
): { headMessages: PrunableMessage[]; tailStartId: string | undefined } {
  const usable = getUsableTokens(model);
  const budget = Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable * 0.25))
  );

  let tokenAccumulator = 0;
  let userTurnsSeen = 0;
  let tailStartIndex = messages.length;

  // Walk backwards through messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const messageTokens = estimateMessageTokens(message.parts);

    // Check if adding this message would exceed budget
    if (tokenAccumulator + messageTokens > budget && userTurnsSeen > 0) {
      tailStartIndex = i + 1;
      break;
    }

    tokenAccumulator += messageTokens;

    // Count user turns
    if (message.role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= TAIL_TURNS) {
        tailStartIndex = i;
        break;
      }
    }
  }

  const headMessages = messages.slice(0, tailStartIndex);
  const tailStartId =
    tailStartIndex < messages.length ? messages[tailStartIndex].id : undefined;

  return { headMessages, tailStartId };
}

// Summarization Prompt Builders

export function buildCompactionPrompt(previousSummary?: string): string {
  if (previousSummary) {
    return `<previous-summary>
${previousSummary}
</previous-summary>

Update the anchored summary above by preserving still-true details, removing stale details, and merging in new facts from the conversation history below.

${SUMMARY_TEMPLATE}`;
  }

  return SUMMARY_TEMPLATE;
}

export function getCompactionSystemPrompt(): string {
  return COMPACTION_SYSTEM_PROMPT;
}

// Message Preparation for Summarization

export function prepareMessagesForSummarization(
  messages: PrunableMessage[]
): string {
  const formatted: string[] = [];

  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    const contentParts: string[] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        contentParts.push(part.text);
      } else if (part.type === "reasoning") {
        contentParts.push(`[thinking] ${part.text}`);
      } else if (part.type === "file") {
        contentParts.push("[attached file]");
      } else if (part.type === "dynamic-tool") {
        let toolStr = `[tool: ${part.toolName}]`;

        if (part.input !== undefined) {
          const inputStr = JSON.stringify(part.input);
          const truncatedInput =
            inputStr.length > 500 ? inputStr.substring(0, 500) + "..." : inputStr;
          toolStr += `\ninput: ${truncatedInput}`;
        }

        if (part.output !== undefined) {
          const outputStr =
            typeof part.output === "string"
              ? part.output
              : JSON.stringify(part.output);
          const truncatedOutput =
            outputStr.length > TOOL_OUTPUT_MAX_CHARS
              ? outputStr.substring(0, TOOL_OUTPUT_MAX_CHARS) + "..."
              : outputStr;
          toolStr += `\noutput: ${truncatedOutput}`;
        }

        contentParts.push(toolStr);
      }
    }

    formatted.push(`${role}: ${contentParts.join("\n")}`);
  }

  return formatted.join("\n\n");
}

// Compaction-event helpers (message-based architecture)

/**
 * A "completed compaction" is a user message containing a `CompactionPart`
 * immediately followed by an assistant message marked `summary: true`.
 *
 * The pair represents one auto- or manually-triggered compaction event.
 * The pre-compaction head can be safely dropped from the LLM view; the
 * UI keeps the full history.
 */
export interface CompactionEvent {
  /** Index of the user message carrying the CompactionPart. */
  userIndex: number;
  /** Index of the assistant message carrying the summary text. */
  summaryIndex: number;
  /** The CompactionPart on the user message (carries `tailStartMessageId`). */
  part: CompactionPart;
  /** Plain-text summary extracted from the assistant message. */
  summaryText: string;
  /** Timestamp the assistant summary was created at (ms). */
  completedAt: number;
}

/**
 * Walks `messages` in order and identifies completed compaction events.
 *
 * A compaction is "completed" when the user-with-CompactionPart is
 * immediately followed by an assistant with `summary: true`. Returns
 * events in chronological order.
 */
export function findCompactionEvents(
  messages: { role: string; parts: any[]; summary?: boolean; createdAt?: number }[],
): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const part = m.parts.find(
      (p): p is CompactionPart => p.type === "data-compaction",
    );
    if (!part) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant" || !next.summary) continue;
    const summaryText = next.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    events.push({
      userIndex: i,
      summaryIndex: i + 1,
      part,
      summaryText,
      completedAt: next.createdAt ?? 0,
    });
  }
  return events;
}

/**
 * Time-based debounce: returns true if a recent compaction event finished
 * within `COMPACTION_DEBOUNCE_MS`, indicating we shouldn't run another one
 * yet. Replaces the legacy `attempts` counter.
 */
export function shouldDebounceCompaction(
  events: CompactionEvent[],
  nowMs: number = Date.now(),
): boolean {
  const last = events.at(-1);
  if (!last) return false;
  return nowMs - last.completedAt < COMPACTION_DEBOUNCE_MS;
}

/**
 * Reorders messages for the LLM view. For the latest completed compaction,
 * the pre-event head is dropped; the compaction-user message is kept (its
 * CompactionPart will be replaced with synthetic prompt text by the
 * transport before sending), followed by the summary assistant, the
 * retained tail (anchored at `tailStartMessageId` if present, else the
 * messages immediately after the event), and any post-event messages.
 *
 * Returns the original array (unchanged) if there are no completed
 * compactions.
 */
export function filterCompactedMessages<
  T extends { id: string; role: string; parts: any[] },
>(messages: T[]): T[] {
  const events = findCompactionEvents(messages);
  const last = events.at(-1);
  if (!last) return messages;

  const tailStartId = last.part.data.tailStartMessageId;
  const tailIdx = tailStartId
    ? messages.findIndex((m) => m.id === tailStartId)
    : -1;

  // Tail boundary either points back to a message in the pre-compaction
  // head (the normal case — we drop everything before it but keep that
  // message), or it's missing/stale (defensive: fall back to dropping
  // everything before the compaction event itself).
  const retainedTailStart =
    tailIdx >= 0 && tailIdx < last.userIndex ? tailIdx : last.userIndex;

  return [
    // 1. The compaction-user marker (the transport substitutes its
    //    CompactionPart with a "What did we do so far?" text part for the
    //    model view).
    messages[last.userIndex],
    // 2. The summary assistant message.
    messages[last.summaryIndex],
    // 3. The retained tail — messages from the tail boundary up to (but
    //    not including) the compaction-user message.
    ...messages.slice(retainedTailStart, last.userIndex),
    // 4. Everything after the summary message (auto-continue + subsequent
    //    turns).
    ...messages.slice(last.summaryIndex + 1),
  ];
}

/**
 * Compose the prompt content the model sees in place of a CompactionPart.
 * Keeping this as a single source of truth avoids drift between the
 * transport (which substitutes at send time) and any future consumer.
 */
export const COMPACTION_USER_PROMPT = "What did we do so far?";

