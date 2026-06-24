import type {
  AgentUIMessage,
  CompletionCheckRejectionData,
  CompletionCheckRunningData,
} from "@/lib/types";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { CompletionCheckBlock } from "./CompletionCheckBlock";
import { CompletionCheckRunningBlock } from "./CompletionCheckRunningBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { ToolApprovalBlock } from "./ToolApprovalBlock";
import { StepGroup } from "./StepGroup";
import { GeneratingIndicator } from "./GeneratingIndicator";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import { capturedToolOrigins, allowToolOnSite, setCloseTabsAlwaysAllowed } from "@/lib/agent/agent-transport";
import { memo } from "react";
import "@/components/chat/tool-previews";

/**
 * The exact errorText that `healPendingTools` (useAgentChat) and
 * `repairToolPart` (compacting-transport) stamp onto a tool part that was
 * orphaned by an interrupted turn and folded to `output-error`. Such a part
 * is an INTERRUPTION, not a genuine tool failure, so we surface it with the
 * muted "Interrupted" badge rather than the red "Failed" one. Kept in sync
 * with the source-of-truth constant in those two modules (the same literal
 * is also matched in `tool-results/delegate.tsx`).
 */
const TOOL_HEAL_INTERRUPT_TEXT =
  "Tool execution was interrupted before it returned a result";

/**
 * Map a tool UIPart's terminal/non-terminal `state` to the visual state
 * the chat row should render in, plus the `result` payload to hand to
 * the row's body.
 *
 * The AI SDK's tool UIPart can land in one of: `input-streaming`,
 * `input-available`, `approval-requested`, `approval-responded`,
 * `output-available`, `output-error`, `output-denied`. Earlier this
 * helper only recognized `output-available` and `output-denied`, so an
 * `output-error` part (e.g. from a tool that threw and the wrapper
 * serialized as `{ error: "..." }` but the SDK normalized into the
 * dedicated `output-error` state with an `errorText`) silently fell
 * through to `state="call"` — the "Running code..." pending row,
 * forever.
 *
 * Treat `output-error` as terminal:
 *  - Surface a synthetic `{ error: errorText }` object so existing
 *    custom renderers (e.g. `<CodeResult>`) light up their red error
 *    path automatically.
 *  - Tell `ToolCallBlock` to use the `"errored"` row variant. The
 *    `errorKind` discriminator picks the badge: a genuine failure shows
 *    a red "Failed" suffix; a heal-injected interruption (matched by
 *    `TOOL_HEAL_INTERRUPT_TEXT`) keeps the muted "Interrupted" suffix.
 *
 * `isStreaming` guards against false positives: while the assistant
 * message is still streaming, a non-terminal tool part is genuinely
 * in flight and should render as pending (`"call"`). Once the message
 * finishes streaming, any remaining non-terminal part is an orphan —
 * the SDK will never advance it — and should render as `"errored"`.
 * This catches cases like `approval-responded` where the user approved
 * but the agent loop never picked the call back up to invoke
 * `execute()`.
 */
export function resolveToolPartState(
  p: { state?: unknown; output?: unknown; errorText?: unknown; approval?: unknown },
  opts: { isStreaming?: boolean } = {},
): {
  state: "call" | "result" | "denied" | "errored";
  result?: unknown;
  errorKind?: "failed" | "interrupted";
} {
  const state = p.state;

  if (state === "output-available") {
    return { state: "result", result: p.output };
  }
  if (state === "output-error") {
    const errText =
      typeof p.errorText === "string" && p.errorText.length > 0
        ? p.errorText
        : "Tool execution failed";
    // Distinguish a real tool failure from a heal-injected interruption.
    // `healPendingTools` / `repairToolPart` fold an orphaned (turn ended
    // before it returned) tool part to `output-error` with the exact
    // `TOOL_HEAL_INTERRUPT_TEXT`. Those are interruptions → muted
    // "Interrupted" badge. Any other `output-error` is a genuine failure
    // (the tool ran and threw / returned an error, e.g. an MCP connector
    // tool that got bad JSON) → red "Failed" badge.
    const errorKind =
      errText === TOOL_HEAL_INTERRUPT_TEXT ? "interrupted" : "failed";
    return { state: "errored", result: { error: errText }, errorKind };
  }
  if (state === "output-denied") {
    return { state: "denied" };
  }

  // An APPROVED `approval-responded` call is a legitimate resume point: the
  // SDK re-executes it from this state via the `tool-approval-response` it
  // emits during convertToModelMessages. There is a brief window right after
  // the user clicks Allow where the message is no longer streaming but the
  // tool hasn't re-invoked `execute()` yet — treating it as an orphan here
  // flashes "Interrupted" before it flips to the real result. Mirror the
  // persistence-heal exception (see `needsHeal` in useAgentChat) and render
  // it as pending. A DENIED approval-responded is terminal — render it as
  // "denied" immediately (regardless of streaming), matching the eventual
  // healed `output-denied`; otherwise a denied call (e.g. a declined
  // executePython) wrongly shows the pending "running" row while the stream
  // is still live.
  if (state === "approval-responded") {
    const ap = p.approval as { id?: unknown; approved?: unknown } | undefined;
    if (ap && ap.approved === false) {
      return { state: "denied" };
    }
    if (
      ap &&
      typeof ap.id === "string" &&
      ap.approved === true &&
      p.output === undefined
    ) {
      return { state: "call" };
    }
  }

  // A call awaiting approval is suspended but genuinely live from the user's
  // perspective — it hasn't timed out or been interrupted, it's just paused.
  if (state === "approval-requested") {
    return { state: "call" };
  }

  // Non-terminal state. If the message is still streaming this part is
  // genuinely in flight — render as pending. If streaming has finished,
  // the part is an orphan that will never advance.
  if (opts.isStreaming) {
    return { state: "call" };
  }

  // Orphan: produce a human-readable error distinguishing the two main
  // cases so the user understands what happened. These are interruptions
  // (the turn ended before the tool resolved), not genuine failures, so
  // `errorKind: "interrupted"` keeps the muted "Interrupted" badge.
  const orphanMessage =
    state === "approval-responded"
      ? "Tool execution was skipped after approval."
      : "Tool did not return a result before the turn ended.";
  return {
    state: "errored",
    result: { error: orphanMessage },
    errorKind: "interrupted",
  };
}

interface AssistantMessageProps {
  message: AgentUIMessage;
  isStreaming?: boolean;
  onToolApproval?: (opts: { id: string; approved: boolean }) => void;
  dimmed?: boolean;
}

/**
 * Part types that belong inside a "step" group: tool calls and the reasoning
 * that accompanies them. These get folded into the "Completed N steps"
 * collapsible once the assistant begins its answer text. `step-start` is
 * grouped too (skipped at render time) so it never breaks a run of tools.
 */
function isWorkPart(part: AgentUIMessage["parts"][number]): boolean {
  const t = part.type;
  return (
    t === "reasoning" ||
    t === "dynamic-tool" ||
    t === "step-start" ||
    (typeof t === "string" && t.startsWith("tool-"))
  );
}

/** Count tool-call parts in a group (drives the "N steps" label). */
function countToolParts(parts: { type: string }[]): number {
  return parts.filter(
    (p) => p.type === "dynamic-tool" || p.type.startsWith("tool-"),
  ).length;
}

/**
 * True if a group contains an in-flight approval request. Such a group must
 * never be folded — the user needs to see and act on the prompt.
 */
function hasPendingApproval(parts: AgentUIMessage["parts"]): boolean {
  return parts.some(
    (p) => (p as { state?: unknown }).state === "approval-requested",
  );
}

type Segment =
  | { kind: "break"; part: AgentUIMessage["parts"][number]; index: number }
  | {
      kind: "group";
      parts: { part: AgentUIMessage["parts"][number]; index: number }[];
    };

/** Build render segments: runs of work parts grouped, break parts standalone. */
function buildSegments(parts: AgentUIMessage["parts"]): Segment[] {
  const segments: Segment[] = [];
  let current: { part: AgentUIMessage["parts"][number]; index: number }[] = [];

  const flush = () => {
    if (current.length > 0) {
      segments.push({ kind: "group", parts: current });
      current = [];
    }
  };

  parts.forEach((part, index) => {
    if (isWorkPart(part)) {
      current.push({ part, index });
    } else {
      flush();
      segments.push({ kind: "break", part, index });
    }
  });
  flush();
  return segments;
}

function AssistantMessageImpl({ message, isStreaming = false, onToolApproval, dimmed }: AssistantMessageProps) {
  const parts = message.parts;
  const segments = buildSegments(parts);

  // Index of the last group segment — the only one that can still be "active"
  // (tools running, no answer text yet).
  const lastGroupSegmentIndex = (() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].kind === "group") return i;
    }
    return -1;
  })();

  // Does any non-empty text part exist after a given part index? If so, the
  // group that precedes it has produced its answer and should fold.
  const hasTextAfter = (index: number): boolean =>
    parts.some(
      (p, i) => i > index && p.type === "text" && p.text.length > 0,
    );

  const renderPart = (part: AgentUIMessage["parts"][number], i: number) => {
    if (part.type === "text") {
      const isLastPart = i === parts.length - 1;
      return (
        <Markdown
          key={i}
          source={part.text}
          isStreaming={isStreaming && isLastPart}
        />
      );
    }
    if (part.type === "reasoning") {
      const nextPart = parts[i + 1];
      const isActivelyReasoning = isStreaming && (!nextPart || (nextPart.type === "text" && !nextPart.text));
      return (
        <Reasoning
          key={i}
          text={part.text}
          isStreaming={isActivelyReasoning}
        />
      );
    }
    if (part.type === "dynamic-tool") {
            // proposePlan's approval surface lives in the chat composer
            // (see `findPendingPlanApproval` + `<PlanApprovalCard>` in
            // ChatView). Skip the inline approval block entirely; the
            // fall-through below renders a `<ToolCallBlock>` showing
            // "Drafting plan..." in the message stream as a breadcrumb,
            // while the composer-level card carries the actual buttons.
            if (
              part.state === "approval-requested" &&
              "approval" in part &&
              onToolApproval &&
              part.toolName !== "proposePlan"
            ) {
              const approval = part.approval as { id: string };
              return (
                <ToolApprovalBlock
                  key={part.toolCallId}
                  toolName={part.toolName}
                  toolCallId={part.toolCallId}
                  args={(part.input as Record<string, unknown>) ?? {}}
                  approvalId={approval.id}
                  siteOrigin={capturedToolOrigins.get(part.toolCallId)}
                  onApprove={(id) => onToolApproval({ id, approved: true })}
                  onDeny={(id) => onToolApproval({ id, approved: false })}
                  onAlwaysAllow={allowToolOnSite}
                  {...(part.toolName === "closeTabs"
                    ? {
                        alwaysAllowGlobalLabel: "Always allow closing tabs the agent opened",
                        onAlwaysAllowGlobal: () => setCloseTabsAlwaysAllowed(true),
                      }
                    : {})}
                />
              );
            }
            const toolState = resolveToolPartState(part, { isStreaming });
            const errorText =
              toolState.state === "errored" && "errorText" in part
                ? ((part as { errorText?: string }).errorText ?? "")
                : undefined;
            return (
              <ToolCallBlock
                key={part.toolCallId}
                toolName={part.toolName}
                toolCallId={part.toolCallId}
                args={(part.input as Record<string, unknown>) ?? {}}
                result={toolState.result}
                state={toolState.state}
                {...(toolState.errorKind && { errorKind: toolState.errorKind })}
                {...(errorText !== undefined && { errorText })}
              />
            );
          }
          if (part.type === "file" && part.mediaType.startsWith("image/")) {
            return (
              <ZoomableImage
                key={i}
                src={part.url}
                alt="Generated image"
                className="max-w-full max-h-[300px] rounded-md my-1"
              />
            );
          }
          if (part.type === "data-completion-check-rejection") {
            // The SDK narrows `part.data` to
            // `CompletionCheckRejectionData` because the part type is
            // registered in `AgentDataParts`. Cast for safety against
            // future schema drift.
            const data = part.data as CompletionCheckRejectionData;
            return <CompletionCheckBlock key={i} data={data} />;
          }
          if (part.type === "data-completion-check-running") {
            // Live status indicator for an in-flight evaluator call.
            // Renders a "Running quality check…" spinner during the
            // "evaluating" phase; renders nothing once the gate
            // resolves (any outcome). For rejected/force-emitted
            // outcomes the sibling `data-completion-check-rejection`
            // block carries the user-facing message; for
            // approved/skipped outcomes the gate is silent (the
            // user already sees the response — no badge).
            // `isStreaming` is a defensive guard against stale
            // "evaluating" parts from aborted streams.
            const data = part.data as CompletionCheckRunningData;
            return (
              <CompletionCheckRunningBlock
                key={i}
                data={data}
                isStreaming={isStreaming}
              />
            );
          }
          if (typeof part.type === "string" && part.type.startsWith("tool-")) {
            if ("toolCallId" in part && "state" in part && "input" in part) {
              const toolName = part.type.slice(5);
              const p = part as Record<string, unknown>;
              // proposePlan's approval surface lives in the chat composer;
              // see the parallel comment in the dynamic-tool branch above.
              if (
                p.state === "approval-requested" &&
                "approval" in p &&
                onToolApproval &&
                toolName !== "proposePlan"
              ) {
                const approval = p.approval as { id: string };
                return (
                  <ToolApprovalBlock
                    key={part.toolCallId}
                    toolName={toolName}
                    toolCallId={part.toolCallId}
                    args={(p.input as Record<string, unknown>) ?? {}}
                    approvalId={approval.id}
                    siteOrigin={capturedToolOrigins.get(part.toolCallId)}
                    onApprove={(id) => onToolApproval({ id, approved: true })}
                    onDeny={(id) => onToolApproval({ id, approved: false })}
                    onAlwaysAllow={allowToolOnSite}
                    {...(toolName === "closeTabs"
                      ? {
                          alwaysAllowGlobalLabel: "Always allow closing tabs the agent opened",
                          onAlwaysAllowGlobal: () => setCloseTabsAlwaysAllowed(true),
                        }
                      : {})}
                  />
                );
              }
              const toolState = resolveToolPartState(p, { isStreaming });
              const errorText =
                toolState.state === "errored" && typeof p.errorText === "string"
                  ? (p.errorText as string)
                  : undefined;
              return (
                <ToolCallBlock
                  key={part.toolCallId}
                  toolName={toolName}
                  toolCallId={part.toolCallId}
                  args={(p.input as Record<string, unknown>) ?? {}}
                  result={toolState.result}
                  state={toolState.state}
                  {...(toolState.errorKind && { errorKind: toolState.errorKind })}
                  {...(errorText !== undefined && { errorText })}
                />
              );
            }
          }
          return null;
  };

  return (
    <div className={`group/message flex flex-col items-start gap-1 ${dimmed ? "opacity-40" : ""}`}>
      <div className="w-full text-sm text-foreground">
        {segments.map((segment, si) => {
          if (segment.kind === "break") {
            return renderPart(segment.part, segment.index);
          }

          // A work group. Count tool calls — a group with no tool calls (e.g.
          // reasoning-only) renders inline without the step wrapper.
          const groupParts = segment.parts.map((p) => p.part);
          const toolCount = countToolParts(groupParts);
          const rendered = segment.parts.map(({ part, index }) =>
            renderPart(part, index),
          );

          // No tool calls, fewer than 3 tool steps, or an in-flight approval
          // the user must see/act on: render inline (no fold). Only runs of
          // 3+ tool calls collapse into a "Completed N steps" block.
          if (toolCount < 3 || hasPendingApproval(groupParts)) {
            return (
              <div key={`g${si}`} className="flex w-full flex-col">
                {rendered}
              </div>
            );
          }

          // Active = trailing group of a streaming message that hasn't produced
          // answer text yet.
          const lastPartIndex =
            segment.parts[segment.parts.length - 1]?.index ?? -1;
          const isActive =
            isStreaming &&
            si === lastGroupSegmentIndex &&
            !hasTextAfter(lastPartIndex);

          return (
            <StepGroup key={`g${si}`} stepCount={toolCount} isActive={isActive}>
              {rendered}
            </StepGroup>
          );
        })}
        {isStreaming && <GeneratingIndicator />}
      </div>
      <MessageActions message={message} />
    </div>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);
