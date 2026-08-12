import type { AgentUIMessage } from "@/lib/agent/message-types";
import {
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_TOOL_NAME,
  type AskUserQuestion,
} from "@/lib/agent/tools/ask-user";

/**
 * A pending `askUser` call surfaced from the message list, ready for the
 * composer to render as a {@link QuestionCard}.
 */
export interface PendingQuestion {
  toolCallId: string;
  /**
   * Fully-parsed questions. Unlike {@link findPendingPlanApproval}, which
   * hands the card a `Partial<>` because it renders mid-stream, this is
   * complete: we only return a call in `input-available`, which the SDK
   * assigns once the tool-call JSON has finished parsing. Malformed
   * questions are dropped here so the card can render without defenses.
   */
  questions: AskUserQuestion[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Narrow one streamed question object to {@link AskUserQuestion}.
 *
 * The tool's zod schema already enforces all of this on the way out of
 * the model, so a rejection here means the part was hand-edited, written
 * by an older build, or corrupted in chatDb. We drop rather than throw:
 * a partially-valid question set is still answerable, and a hard failure
 * would strand the run with no way to resume.
 */
function parseQuestion(value: unknown): AskUserQuestion | null {
  if (!isPlainObject(value)) return null;
  if (!isNonEmptyString(value.question)) return null;
  if (!isNonEmptyString(value.header)) return null;
  if (!Array.isArray(value.options)) return null;

  const options: AskUserQuestion["options"] = [];
  for (const raw of value.options) {
    if (!isPlainObject(raw)) continue;
    if (!isNonEmptyString(raw.label)) continue;
    options.push({
      label: raw.label,
      description: isNonEmptyString(raw.description) ? raw.description : "",
    });
  }
  // Below the minimum there is nothing to choose between; above the
  // maximum the model ignored a hard bound and the card layout breaks.
  // Both are schema violations, so treat them the same way.
  if (
    options.length < ASK_USER_MIN_OPTIONS ||
    options.length > ASK_USER_MAX_OPTIONS
  ) {
    return null;
  }

  // Duplicate labels within a question make the answer ambiguous (the
  // card keys selection state by label). The tool schema rejects this,
  // so reaching it means a corrupted part.
  const labels = options.map((o) => o.label);
  if (new Set(labels).size !== labels.length) return null;

  return {
    question: value.question,
    header: value.header,
    options,
    multiSelect: value.multiSelect === true,
  };
}

/**
 * Locate an answerable `askUser` call, if any.
 *
 * Two constraints, both stricter than {@link findPendingPlanApproval}:
 *
 * 1. **The part must be on the LAST message, not merely the last
 *    assistant message.** `addToolOutput` locates the part by scanning
 *    `messages.at(-1)` only (`ai/dist/index.mjs`), so if the user has
 *    since sent a message, answering would either no-op or write an
 *    `output` onto the wrong message. Requiring "last message overall"
 *    makes the card's presence exactly equal to "answering will work".
 *
 * 2. **State must be `input-available`, not `input-streaming`.** A
 *    streaming call has partial JSON — options may be half-emitted or
 *    absent. Rendering then answering it would submit against a question
 *    set the model hadn't finished writing. The composer stays put for
 *    the fraction of a second the input takes to stream; the inline
 *    `<ToolCallBlock>` already shows "Asking you..." in the meantime.
 *
 * Recognizes both AI-SDK part shapes, because the live stream produces
 * `tool-askUser` while `deserializePart` rehydrates chatDb rows as
 * `dynamic-tool`:
 *   - `{ type: "dynamic-tool", toolName: "askUser", state: "input-available" }`
 *   - `{ type: "tool-askUser", state: "input-available" }`
 */
export function findPendingQuestion(
  messages: ReadonlyArray<AgentUIMessage>,
): PendingQuestion | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;

  for (const part of last.parts) {
    const p = part as {
      type?: string;
      toolName?: string;
      state?: string;
      toolCallId?: string;
      input?: unknown;
    };
    if (p.state !== "input-available") continue;
    const isAskUser =
      (p.type === "dynamic-tool" && p.toolName === ASK_USER_TOOL_NAME) ||
      p.type === `tool-${ASK_USER_TOOL_NAME}`;
    if (!isAskUser) continue;
    if (!isNonEmptyString(p.toolCallId)) continue;
    if (!isPlainObject(p.input)) continue;
    if (!Array.isArray(p.input.questions)) continue;

    const questions = p.input.questions
      .map(parseQuestion)
      .filter((q): q is AskUserQuestion => q !== null);
    // Every question was malformed — there is nothing to render. Leave
    // the part alone; the next submit/retry heals it to `output-error`
    // and the model sees a benign "interrupted" result.
    if (questions.length === 0) continue;

    return { toolCallId: p.toolCallId, questions };
  }
  return null;
}
