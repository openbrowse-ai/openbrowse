/**
 * Renders a subagent run as a collapsible trace block.
 *
 * The block has a single inline header row (Bot + slug + title + step
 * count + status pill + chevron) and a vertical-rail content list of
 * parts.
 *
 * Part rendering:
 *  - Tool parts map directly to the chat's standard `ToolCallBlock`
 *    component, so they look and behave exactly like top-level tools
 *    (expandable, same icons, same result renderers).
 *  - Reasoning parts use the standard `Reasoning` component.
 *  - Text parts render as markdown inline with the tool calls.
 *  - `setTaskTitle` calls are skipped (the title is in the header).
 *
 * The component is purely presentational — DelegateResult owns the
 * live transcript subscription and title-event listener and feeds the
 * latest snapshot in via `transcript` + `triggerTitle` + `isRunning` /
 * `isFailed`. The expanded body also shows the delegation `task`
 * prompt above the trace and the resolved `model` in a footer; the
 * trace itself auto-scrolls to the bottom as new parts stream in
 * (via `use-stick-to-bottom`), pausing when the user scrolls up.
 */

import { Bot, ChevronDownIcon } from "lucide-react";
import type { ReactNode, ComponentProps } from "react";
import Markdown from "react-markdown";
import { StickToBottom } from "use-stick-to-bottom";
import { Shimmer } from "../../ai-elements/shimmer";
import { Reasoning } from "../../ai-elements/reasoning";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { ToolCallBlock } from "../ToolCallBlock";
import { cn } from "../../../lib/utils";
import type { SerializedUIPart } from "../../../lib/agent/message-types";
import type { SerializedAssistantMessage } from "../../../lib/agent/subagents/types";

interface Props {
  /** Per-message transcript captured during the subagent run. */
  transcript: SerializedAssistantMessage[];
  /** Subagent slug (e.g. `extractor`). */
  slug: string;
  /** Trigger title shown in the header. */
  triggerTitle: string;
  /** True while the parent's `delegate` tool call is still pending. */
  isRunning: boolean;
  /** True when the run finished in a non-success terminal state. */
  isFailed: boolean;
  /** Pass-through of error message to render in the trace content */
  error?: string;
  /**
   * The task prompt passed to the subagent (the delegate `task` arg).
   * Rendered in a read-only block above the trace when expanded.
   */
  task?: string;
  /**
   * The model the subagent ran on (e.g. `anthropic:claude-sonnet-4-6`).
   * Rendered in a footer below the trace when expanded. `null` means the
   * subagent inherited the parent's model.
   */
  model?: string | null;
}

export function SubagentTrace({
  transcript,
  slug,
  triggerTitle,
  isRunning,
  isFailed,
  error,
  task,
  model,
}: Props) {
  const stepCount = transcript.reduce(
    (acc, m) => acc + countMeaningfulParts(m.parts),
    0,
  );
  const stepLabel = stepCount === 1 ? "1 step" : `${stepCount} steps`;

  return (
    <div className="my-1">
      <TraceBlock>
        <TraceBlockTrigger
          title={triggerTitle}
          slug={slug}
          isRunning={isRunning}
          isFailed={isFailed}
          stepLabel={stepCount > 0 ? stepLabel : undefined}
        />
        <CollapsibleContent
          className={cn(
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2",
            "data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none",
            "data-[state=closed]:animate-out data-[state=open]:animate-in",
          )}
        >
          {task && task.trim().length > 0 && (
            <div className="mt-2 rounded-md border border-muted/40 bg-muted/30 px-3 py-2">
              <div className="mb-1 font-medium text-[10px] uppercase tracking-wide text-muted-foreground/60">
                Prompt
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/80 prose-p:my-0.5 prose-p:leading-snug max-h-[140px] overflow-y-auto styled-scrollbar">
                <Markdown>{task}</Markdown>
              </div>
            </div>
          )}
          <StickToBottom
            className="mt-2 max-h-[400px] overflow-y-auto styled-scrollbar border-muted border-l-2 pl-4 pr-1"
            initial="instant"
            resize="instant"
          >
            <StickToBottom.Content className="space-y-1">
              {transcript.flatMap((message, mi) =>
                message.parts.map((part, pi) => (
                  <PartRow key={`${mi}-${pi}`} part={part} />
                )),
              )}
              {error && (
                <TraceBlockItem>
                  <div className="w-full rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 mt-2">
                    <pre className="whitespace-pre-wrap font-mono text-xs text-red-400">
                      {error}
                    </pre>
                  </div>
                </TraceBlockItem>
              )}
            </StickToBottom.Content>
          </StickToBottom>
          <div className="mt-2 flex items-center gap-1.5 border-t border-muted/30 pt-2 text-[11px] text-muted-foreground/70">
            <span className="shrink-0 opacity-70">Model</span>
            <span className="truncate font-mono" title={model ?? undefined}>
              {model ?? "inherits parent model"}
            </span>
          </div>
        </CollapsibleContent>
      </TraceBlock>
    </div>
  );
}

function PartRow({ part }: { part: SerializedUIPart }) {
  if (part.type === "text") {
    if (!part.text) return null;
    return (
      <TraceBlockItem className="prose prose-sm dark:prose-invert max-w-none text-foreground/80 prose-p:my-0.5 prose-p:leading-snug">
        <Markdown>{part.text}</Markdown>
      </TraceBlockItem>
    );
  }
  if (part.type === "reasoning") {
    if (!part.text) return null;
    return (
      <TraceBlockItem>
        <Reasoning text={part.text} isStreaming={false} />
      </TraceBlockItem>
    );
  }
  if (part.type === "dynamic-tool") {
    if (part.toolName === "setTaskTitle") return null;

    const state =
      part.state === "output-available"
        ? ("result" as const)
        : part.state === "output-denied"
          ? ("denied" as const)
          : ("call" as const);

    return (
      <ToolCallBlock
        toolName={part.toolName}
        toolCallId={part.toolCallId}
        args={(part.input as Record<string, unknown>) ?? {}}
        result={part.output}
        state={state}
      />
    );
  }
  // step-start, data-compaction, file, source-url — skip in trace.
  return null;
}

function countMeaningfulParts(parts: SerializedUIPart[]): number {
  return parts.filter(
    (p) =>
      p.type === "dynamic-tool" ||
      (p.type === "text" && p.text.length > 0) ||
      (p.type === "reasoning" && p.text.length > 0),
  ).length;
}

// --- Local Primitives --------------------------------------------------------

type TraceBlockProps = ComponentProps<typeof Collapsible>;

const TraceBlock = ({
  defaultOpen = true,
  className,
  ...props
}: TraceBlockProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

type TraceBlockTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  slug: string;
  isRunning: boolean;
  isFailed: boolean;
  stepLabel?: string;
};

const TraceBlockTrigger = ({
  className,
  title,
  slug,
  isRunning,
  isFailed,
  stepLabel,
  ...props
}: TraceBlockTriggerProps) => (
  <CollapsibleTrigger asChild className={cn("group", className)} {...props}>
    <div className="group flex w-full cursor-pointer items-center gap-2 rounded-sm py-0.5 px-1 -mx-1 text-muted-foreground text-sm transition-colors hover:bg-accent/50 hover:text-foreground">
      <Bot className="size-4 shrink-0" />
      <span className="shrink-0 text-foreground/70 font-mono">
        {slug.charAt(0).toUpperCase() + slug.slice(1)} Agent
      </span>
      {isFailed && (
        <span
          aria-label="failed"
          className="size-1.5 shrink-0 rounded-full bg-destructive"
        />
      )}
      <span className="shrink-0 opacity-50">·</span>
      {isRunning ? (
        <Shimmer
          as="span"
          className="text-sm flex-1 truncate text-left"
          duration={2}
        >
          {title}
        </Shimmer>
      ) : (
        <span
          className={cn(
            "flex-1 truncate text-left",
            isFailed && "text-muted-foreground",
          )}
          title={title}
        >
          {title}
        </span>
      )}
      {stepLabel && (
        <span className="shrink-0 text-xs opacity-60">{stepLabel}</span>
      )}
      <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
    </div>
  </CollapsibleTrigger>
);

type TraceBlockItemProps = ComponentProps<"div">;

const TraceBlockItem = ({ children, className, ...props }: TraceBlockItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
);

