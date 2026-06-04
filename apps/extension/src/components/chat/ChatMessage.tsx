import type { AgentUIMessage } from "@/lib/types";
import { memo, useCallback } from "react";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";

interface ChatMessageProps {
  message: AgentUIMessage;
  isStreaming?: boolean;
  /**
   * Stable, id-taking callbacks. The list passes a single stable function
   * identity for all rows; this component binds `message.id` internally so
   * the per-row closure only changes when this row actually re-renders.
   * Combined with `React.memo`, this keeps settled rows from re-rendering
   * when unrelated parent state (e.g. the chat input value) changes.
   */
  onRegenerate?: (id: string) => void;
  onEdit?: (id: string) => void;
  /**
   * Capability flags gate whether the regenerate/edit affordances render.
   * Passing booleans (instead of toggling the callback to `undefined`)
   * keeps the callback identity stable across load/edit transitions.
   */
  canRegenerate?: boolean;
  canEdit?: boolean;
  onToolApproval?: (opts: { id: string; approved: boolean }) => void;
  dimmed?: boolean;
}

function ChatMessageImpl({
  message,
  isStreaming,
  onRegenerate,
  onEdit,
  canRegenerate,
  canEdit,
  onToolApproval,
  dimmed,
}: ChatMessageProps) {
  const handleRegenerate = useCallback(() => {
    onRegenerate?.(message.id);
  }, [onRegenerate, message.id]);

  const handleEdit = useCallback(() => {
    onEdit?.(message.id);
  }, [onEdit, message.id]);

  if (message.role === "system") return null;
  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        onEdit={canEdit && onEdit ? handleEdit : undefined}
        dimmed={dimmed}
      />
    );
  }
  return (
    <AssistantMessage
      message={message}
      isStreaming={isStreaming}
      onRegenerate={canRegenerate && onRegenerate ? handleRegenerate : undefined}
      onToolApproval={onToolApproval}
      dimmed={dimmed}
    />
  );
}

export const ChatMessage = memo(ChatMessageImpl);
