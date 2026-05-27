import { Loader2Icon } from "lucide-react";
import type { CompletionCheckRunningData } from "@/lib/types";

/**
 * Renders a `data-completion-check-running` part as an inline status
 * indicator within an assistant message.
 *
 * Single visual state by design:
 *  - **`"evaluating"`**: small pill with spinner and "Running quality
 *    check…" text. Surfaces the silent window between assistant
 *    streaming finishing and the gate producing a verdict — without
 *    this, evaluator calls that take 5–30 seconds make the UI look
 *    stuck.
 *  - **`"done"`**: renders nothing, regardless of outcome.
 *
 *    Approve / skip: the gate is plumbing; the user already sees the
 *    response. We don't surface a "Verified" badge — that adds noise
 *    on every clean turn without enabling action.
 *
 *    Reject / force-emit: the sibling `data-completion-check-rejection`
 *    block carries the message ("Refining answer" or "This response
 *    may have issues"). Rendering both would double up.
 *
 * `isStreaming` is plumbed from the chat status. We use it to defend
 * against stale `"evaluating"` state — if a stream is aborted mid-
 * gate, the part can persist with `phase: "evaluating"`. (Note: with
 * the strip-on-serialize policy in `useAgentChat.ts`, this case is
 * also handled at persistence time so the part never reaches reload.
 * The runtime guard remains as belt-and-suspenders for in-memory
 * abort scenarios.)
 */
export function CompletionCheckRunningBlock({
  data,
  isStreaming,
}: {
  data: CompletionCheckRunningData;
  isStreaming: boolean;
}) {
  if (data.phase !== "evaluating") return null;
  if (!isStreaming) return null;

  return (
    <div
      className="my-2 inline-flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground"
      data-testid="completion-check-running"
      data-phase="evaluating"
    >
      <Loader2Icon className="size-3 shrink-0 animate-spin" />
      <span>Running quality check…</span>
    </div>
  );
}
