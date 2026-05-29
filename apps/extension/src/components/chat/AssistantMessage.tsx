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
import { ZoomableImage } from "@/components/ui/zoomable-image";
import { capturedToolOrigins, allowToolOnSite } from "@/lib/agent/agent-transport";
import "@/components/chat/tool-previews";

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
 *  - Tell `ToolCallBlock` to use the new `"errored"` row variant so
 *    the collapsed row label shows a red AlertCircle + "Failed" suffix
 *    instead of pretending the tool succeeded.
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
  p: { state?: unknown; output?: unknown; errorText?: unknown },
  opts: { isStreaming?: boolean } = {},
): { state: "call" | "result" | "denied" | "errored"; result?: unknown } {
  const state = p.state;

  if (state === "output-available") {
    return { state: "result", result: p.output };
  }
  if (state === "output-error") {
    const errText =
      typeof p.errorText === "string" && p.errorText.length > 0
        ? p.errorText
        : "Tool execution failed";
    return { state: "errored", result: { error: errText } };
  }
  if (state === "output-denied") {
    return { state: "denied" };
  }

  // Non-terminal state. If the message is still streaming this part is
  // genuinely in flight — render as pending. If streaming has finished,
  // the part is an orphan that will never advance.
  if (opts.isStreaming) {
    return { state: "call" };
  }

  // Orphan: produce a human-readable error distinguishing the two main
  // cases so the user understands what happened.
  const orphanMessage =
    state === "approval-responded"
      ? "Tool execution was skipped after approval."
      : "Tool did not return a result before the turn ended.";
  return { state: "errored", result: { error: orphanMessage } };
}

interface AssistantMessageProps {
  message: AgentUIMessage;
  isStreaming?: boolean;
  onRegenerate?: () => void;
  onToolApproval?: (opts: { id: string; approved: boolean }) => void;
  dimmed?: boolean;
}

export function AssistantMessage({ message, isStreaming = false, onRegenerate, onToolApproval, dimmed }: AssistantMessageProps) {
  return (
    <div className={`group/message flex flex-col items-start gap-1 ${dimmed ? "opacity-40" : ""}`}>
      <div className="w-full text-sm text-foreground">
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            const isLastPart = i === message.parts.length - 1;
            return (
              <Markdown
                key={i}
                source={part.text}
                isStreaming={isStreaming && isLastPart}
              />
            );
          }
          if (part.type === "reasoning") {
            const nextPart = message.parts[i + 1];
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
            if (part.state === "approval-requested" && "approval" in part && onToolApproval) {
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
              if (p.state === "approval-requested" && "approval" in p && onToolApproval) {
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
                  {...(errorText !== undefined && { errorText })}
                />
              );
            }
          }
          return null;
        })}
      </div>
      <MessageActions message={message} onRegenerate={onRegenerate} />
    </div>
  );
}
