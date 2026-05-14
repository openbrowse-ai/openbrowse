import type { UIMessage } from "@ai-sdk/react";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";

interface ChatMessageProps {
  message: UIMessage;
  isStreaming?: boolean;
  onRegenerate?: () => void;
  onToolApproval?: (opts: { id: string; approved: boolean }) => void;
  onEdit?: () => void;
  dimmed?: boolean;
}

export function ChatMessage({ message, isStreaming, onRegenerate, onToolApproval, onEdit, dimmed }: ChatMessageProps) {
  if (message.role === "system") return null;
  if (message.role === "user") return <UserMessage message={message} onEdit={onEdit} dimmed={dimmed} />;
  return (
    <AssistantMessage
      message={message}
      isStreaming={isStreaming}
      onRegenerate={onRegenerate}
      onToolApproval={onToolApproval}
      dimmed={dimmed}
    />
  );
}
