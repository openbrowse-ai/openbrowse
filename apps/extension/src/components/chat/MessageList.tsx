import { memo } from "react";
import type { AgentUIMessage } from "@/lib/types";
import { ChatMessage } from "./ChatMessage";
import { CompactionDivider } from "./CompactionDivider";
import { ExpandableText } from "./tool-results/expandable-text";
import { AlertCircle, RefreshCw, ShieldCheck } from "lucide-react";

interface MessageListProps {
  messages: AgentUIMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  isEditing: boolean;
  /** Index of the message being edited (sent edits), or -1. Rows at and
   *  below this index are dimmed. */
  editingIndex: number;
  showThinking: boolean;
  error: Error | null | undefined;
  /** Stable, id-taking callbacks (see ChatMessage). */
  onEdit: (id: string) => void;
  /** Retry from a user message: discard all turns after it and re-run. */
  onRetryFromUser: (id: string) => void;
  onToolApproval: (opts: { id: string; approved: boolean }) => void;
  /** Error-banner retry: continue the errored turn in place. */
  onRetry: () => void;
  onDismissError: () => void;
}

/**
 * Renders the transcript. Extracted from ChatView and memoized so that
 * unrelated ChatView state changes — most importantly every keystroke in
 * the chat input — do not re-render the (potentially large, markdown- and
 * syntax-highlight-heavy) message list. The component intentionally takes
 * NO `input`/draft state; its props only change on genuine transcript or
 * load/edit/stream transitions.
 */
function MessageListImpl({
  messages,
  isStreaming,
  isLoading,
  isEditing,
  editingIndex,
  showThinking,
  error,
  onEdit,
  onRetryFromUser,
  onToolApproval,
  onRetry,
  onDismissError,
}: MessageListProps) {
  const canAct = !isLoading && !isEditing;
  return (
    <>
      {messages.map((message, i) => {
        // Plan-extension marker: a synthetic user message emitted when
        // the auto-extend hook in agent-transport flips the plan
        // (option-C site append, or network unlock). Render as a small
        // inline notice rather than a chat bubble so it reads as a
        // status line, not a user utterance. Stripped before reaching
        // the LLM (see `rewriteForLLM`).
        const planExtensionPart = message.parts.find(
          (p) => p.type === "data-plan-extension",
        );
        if (message.role === "user" && planExtensionPart) {
          const data = planExtensionPart.data;
          const text =
            data.kind === "site"
              ? `Plan extended: ${data.origin ?? "site"}`
              : "Plan extended: network access permitted";
          return (
            <div
              key={message.id}
              className="flex items-center gap-1.5 text-xs text-muted-foreground py-1 ml-3"
            >
              <ShieldCheck className="size-3" />
              <span>{text}</span>
            </div>
          );
        }

        // Compaction-user message: replace the bubble with a
        // CompactionDivider. The next assistant message in the
        // stream is the summary; we render its text inside the
        // divider's expand panel.
        const compactionPart = message.parts.find(
          (p) => p.type === "data-compaction",
        );
        if (message.role === "user" && compactionPart) {
          const next = messages[i + 1];
          const summaryText =
            next?.role === "assistant"
              ? next.parts
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n")
                  .trim()
              : "";
          return (
            <CompactionDivider
              key={message.id}
              summary={summaryText}
              hiddenCount={i}
              auto={compactionPart.data.auto}
              overflow={compactionPart.data.overflow}
            />
          );
        }

        // Assistant summary message: hide from the main chat. Its
        // content is shown via the divider's expand toggle. We
        // detect it structurally — the previous message is a
        // compaction-user.
        const prev = messages[i - 1];
        const prevIsCompactionUser =
          prev?.role === "user" &&
          prev.parts.some((p) => p.type === "data-compaction");
        if (message.role === "assistant" && prevIsCompactionUser) {
          return null;
        }

        const isLastAssistant =
          message.role === "assistant" &&
          isStreaming &&
          !messages.slice(i + 1).some((m) => m.role === "assistant");
        const isDimmed = editingIndex !== -1 && i >= editingIndex;
        return (
          <ChatMessage
            key={message.id}
            message={message}
            isStreaming={isLastAssistant}
            dimmed={isDimmed}
            onToolApproval={onToolApproval}
            onEdit={onEdit}
            canEdit={message.role === "user" && canAct}
            onRetryFromUser={onRetryFromUser}
            canRetry={message.role === "user" && canAct}
          />
        );
      })}
      {showThinking && <ThinkingIndicator />}
      {error && (
        <ErrorMessage
          error={error}
          onRetry={onRetry}
          onDismiss={onDismissError}
        />
      )}
    </>
  );
}

export const MessageList = memo(MessageListImpl);

function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg px-3 py-2 bg-muted">
        <div className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse" />
          <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:150ms]" />
          <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function ErrorMessage({
  error,
  onRetry,
  onDismiss,
}: {
  error: Error;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm border border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-2">
          <AlertCircle className="size-3.5 text-destructive shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs text-destructive font-medium">
              Something went wrong
            </p>
            {/*
              * Provider SDK errors can carry full request payloads,
              * stack traces, or upstream HTML responses — easily
              * dozens of visual lines. Clamp to ~10 visual lines with
              * an inline expand toggle. `font-sans` overrides
              * ExpandableText's <pre> default so the banner keeps the
              * surrounding chat font; `text-muted-foreground` and
              * `break-words` reproduce the previous styling.
              */}
            <ExpandableText
              text={error.message}
              className="text-xs text-muted-foreground mt-0.5 break-words font-sans"
            />
            <div className="flex items-center gap-2 mt-1.5">
              <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <RefreshCw className="size-3" />
                Retry
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
