import type { UIMessage } from "@ai-sdk/react";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { ToolCallBlock } from "./ToolCallBlock";
import { ToolApprovalBlock } from "./ToolApprovalBlock";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import { capturedToolOrigins, allowToolOnSite } from "@/lib/agent/agent-transport";
import "@/components/chat/tool-previews";

interface AssistantMessageProps {
  message: UIMessage;
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
            const hasOutput = part.state === "output-available";
            const isDenied = (part.state as string) === "output-denied";
            return (
              <ToolCallBlock
                key={part.toolCallId}
                toolName={part.toolName}
                toolCallId={part.toolCallId}
                args={(part.input as Record<string, unknown>) ?? {}}
                result={hasOutput ? part.output : undefined}
                state={isDenied ? "denied" : hasOutput ? "result" : "call"}
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
              const hasOutput = p.state === "output-available";
              const isDenied = p.state === "output-denied";
              return (
                <ToolCallBlock
                  key={part.toolCallId}
                  toolName={toolName}
                  toolCallId={part.toolCallId}
                  args={(p.input as Record<string, unknown>) ?? {}}
                  result={
                    hasOutput && "output" in p ? p.output : undefined
                  }
                  state={isDenied ? "denied" : hasOutput ? "result" : "call"}
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
