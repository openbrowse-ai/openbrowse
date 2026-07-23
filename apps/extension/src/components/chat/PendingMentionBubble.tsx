import { ReadOnlyEditor } from "@/components/tiptap/ReadOnlyEditor";

interface PendingMentionBubbleProps {
  /** The just-submitted message text (with chip tokens), shown read-only. */
  text: string;
}

/**
 * Optimistic echo of a just-submitted message while its chat-mention context
 * is being resolved (and possibly summarized) at send time.
 *
 * Mirrors {@link UserMessage}'s text-bubble treatment but read-only and
 * without the edit/copy affordances. The `chat-mention-resolving` wrapper
 * drives a CSS shimmer on the bubble's `.chat-mention` chips so the send
 * reads as "working" rather than frozen. Rendered by ChatView only while
 * `useAgentChat.pendingMention` is set; the real message replaces it once the
 * turn dispatches.
 */
export function PendingMentionBubble({ text }: PendingMentionBubbleProps) {
  return (
    <div className="group/message flex flex-col items-end gap-1">
      <div className="chat-mention-resolving max-w-[85%] rounded-lg px-3 py-2 text-sm bg-secondary text-secondary-foreground break-words">
        <ReadOnlyEditor
          content={text}
          className="text-secondary-foreground [&_*]:text-secondary-foreground [&>p]:!my-0 [&_p]:!my-0 [&_.tab-mention]:bg-foreground/10 [&_.chat-mention]:bg-foreground/10 [&_.skill-slash]:bg-foreground/10"
        />
      </div>
    </div>
  );
}
