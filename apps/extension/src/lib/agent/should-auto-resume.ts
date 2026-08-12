import { isToolUIPart, type UIMessage } from "ai";
import { ASK_USER_TOOL_NAME } from "./tools/ask-user";

/**
 * The `sendAutomaticallyWhen` predicate for the renderer's `Chat`
 * instance: "should answering this just-resolved interaction start a new
 * agent run?"
 *
 * Extracted from `useAgentChat`'s `getOrCreateChat` for the same reason
 * `healPendingTools` was — it is subtle, load-bearing, and the hook's
 * React/transport import graph makes it untestable in place.
 *
 * We provide this instead of the SDK's `lastAssistantMessageIsComplete-
 * WithApprovalResponses` / `...WithToolCalls` helpers because both are
 * wrong for this app in a way that costs a real, billable extra run:
 *
 *  - The approval helper's terminal set omits `output-denied`, which
 *    strands tool calls that `healPendingTools` resolved to that state:
 *    the resume never fires and an approved sibling call is orphaned in
 *    `approval-responded` with no output.
 *  - The tool-calls helper fires on ANY last step whose tool calls all
 *    have results. But the SDK evaluates this predicate at the end of
 *    every stream, not just after a client-side answer
 *    (`AbstractChat.onFinish` → `shouldSendAutomatically`), so it would
 *    spuriously resubmit whenever a normal turn happens to end on a
 *    completed tool call — e.g. one cut short by the mid-stream
 *    compaction `stopWhen`.
 *
 * So the trigger is explicit: resume only when the last step contains
 * either an approval response or an answered `askUser`, AND every tool in
 * that step has reached a terminal state.
 */
export function shouldAutoResume({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  const message = messages[messages.length - 1];
  if (!message || message.role !== "assistant") return false;

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex: number, part: UIMessage["parts"][number], index: number) =>
      part.type === "step-start" ? index : lastIndex,
    -1,
  );

  const lastStepTools = message.parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolUIPart);

  // At least one of the two triggers must be present. This guard is also
  // load-bearing for the empty-array case: with no tools, both `some()`
  // calls are false so we return early and never reach the `.every()`
  // below (which would vacuously return true).
  const hasApprovalResponse = lastStepTools.some(
    (p) => p.state === "approval-responded",
  );
  // `askUser` is a client-side tool (no `execute`), so the run ends with
  // its call parked in `input-available` and the renderer supplies the
  // output via `addToolOutput`. That write is the trigger.
  const hasAnsweredQuestion = lastStepTools.some(
    (p) =>
      toolNameOf(p) === ASK_USER_TOOL_NAME &&
      (p.state === "output-available" || p.state === "output-error"),
  );
  if (!hasApprovalResponse && !hasAnsweredQuestion) return false;

  // Every tool in the last step must be terminal. `output-denied` (added
  // vs. the SDK reference) and `approval-responded` (the just-approved
  // call awaiting execution) both count — see the block comment above.
  //
  // This also means the resume WAITS on a sibling `askUser` that is still
  // unanswered, which is what we want: both answers belong to the same
  // follow-up turn, and the composer re-renders the card for the second
  // question as soon as the first is resolved.
  return lastStepTools.every(
    (p) =>
      p.state === "output-available" ||
      p.state === "output-error" ||
      p.state === "output-denied" ||
      p.state === "approval-responded",
  );
}

/**
 * Tool name for either AI-SDK tool-part shape. The live stream emits
 * `tool-<name>` for statically-registered tools while `deserializePart`
 * rehydrates chatDb rows as `dynamic-tool`, so both reach this predicate.
 */
function toolNameOf(part: { type: string; toolName?: string }): string {
  return part.type === "dynamic-tool"
    ? (part.toolName ?? "")
    : part.type.slice("tool-".length);
}
