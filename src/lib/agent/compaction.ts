// src/lib/agent/compaction.ts
import type { SerializedUIPart, CompactionState } from "../types";
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
export const MAX_THRASH_ATTEMPTS = 3;
export const MIN_MESSAGES_FOR_COMPACTION = 4;
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

// Anti-Thrashing Helpers

export function shouldStopCompacting(
  state: CompactionState | undefined
): boolean {
  return state !== undefined && state.attempts >= MAX_THRASH_ATTEMPTS;
}

export function incrementAttempts(state: CompactionState): CompactionState {
  return {
    ...state,
    attempts: state.attempts + 1,
  };
}

export function resetAttempts(state: CompactionState): CompactionState {
  return {
    ...state,
    attempts: 0,
  };
}
