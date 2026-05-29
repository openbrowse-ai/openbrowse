/**
 * Shared converters between AI SDK `UIMessage` parts and the
 * `SerializedUIPart` shape we persist in chat-db.
 *
 * Extracted from `useAgentChat.ts` so the subagent runner can persist
 * subagent transcripts under their child conversation id using the
 * same encoding the parent's chat uses. Single source of truth for
 * what a "saved" message looks like.
 *
 * If you add a new `SerializedUIPart` variant, update both `serializeParts`
 * (forward conversion from SDK parts) and `hasMeaningfulContent`
 * (predicate that decides whether a streamed turn is worth saving).
 */

import type { UIMessage } from "ai";
import type { AgentDataParts, SerializedUIPart } from "./message-types";

type AgentMessageParts = UIMessage<unknown, AgentDataParts>["parts"];

/**
 * Convert AI SDK `UIMessage.parts` into the `SerializedUIPart[]` shape
 * stored in chat-db. Drops any parts the chat UI cannot render (returns
 * an empty array for unknown variants — preserves forward-compat).
 */
export function serializeParts(parts: AgentMessageParts): SerializedUIPart[] {
  return parts.flatMap((part): SerializedUIPart[] => {
    switch (part.type) {
      case "text":
        return [{ type: "text", text: part.text }];
      case "reasoning":
        return [{ type: "reasoning", text: part.text }];
      case "file":
        return [{ type: "file", mediaType: part.mediaType, url: part.url }];
      case "source-url":
        return [
          {
            type: "source-url",
            sourceId: part.sourceId,
            url: part.url,
            title: part.title,
          },
        ];
      case "step-start":
        return [{ type: "step-start" }];
      case "data-compaction":
        // `part.data` is `CompactionData` thanks to AgentDataParts.
        return [{ type: "data-compaction", data: part.data }];
      case "data-completion-check-rejection":
        // Persist completion-check rejection blocks so users see the
        // concerns again after a reload. Without this case, the chunk
        // is silently dropped at serialize time and the conversation
        // looks like the gate never ran.
        return [{ type: "data-completion-check-rejection", data: part.data }];
      case "data-completion-check-running":
        // Strip running indicators at serialize time. They're a live-
        // stream concern only:
        //  - "evaluating" entries shouldn't survive reload — saved
        //    means the stream is over forever, but a persisted
        //    "evaluating" part would semantically lie about that
        //    state.
        //  - "done" entries render nothing in the UI (the spinner is
        //    gone; rejected/force-emitted are surfaced by the
        //    sibling rejection block; approved/skipped are silent).
        //    Persisting them would be dead weight in chatDb.
        //
        // The runtime UI guard (`isStreaming` check in
        // CompletionCheckRunningBlock) handles in-memory mid-stream
        // aborts; we never need this part on disk.
        return [];
      case "dynamic-tool":
        return [
          {
            type: "dynamic-tool",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            state: part.state,
            input: part.input,
            output: "output" in part ? part.output : undefined,
            errorText: "errorText" in part ? part.errorText : undefined,
            approval: "approval" in part ? part.approval : undefined,
          },
        ];
      default: {
        const p = part as Record<string, unknown>;
        if (
          typeof part.type === "string" &&
          part.type.startsWith("tool-") &&
          "toolCallId" in p &&
          "state" in p &&
          "input" in p
        ) {
          return [
            {
              type: "dynamic-tool",
              toolName: part.type.slice(5),
              toolCallId: p.toolCallId as string,
              state: p.state as string,
              input: p.input,
              output: "output" in p ? p.output : undefined,
              errorText: "errorText" in p ? (p.errorText as string) : undefined,
            },
          ];
        }
        return [];
      }
    }
  });
}

/** Concatenate the text portions of `parts` into a single string. */
export function extractTextContent(parts: SerializedUIPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Whether `parts` represents a turn worth persisting / showing.
 *
 * The AI SDK's `onFinish` callback fires for every terminal state — including
 * errors that hit before the model produced any content. In that path
 * `parts` ends up empty (or just a `step-start` marker). Saving such a
 * message to chatDb would leave a bare regenerate-icon bubble in the
 * conversation after a refresh.
 *
 * Returning false here from `onFinish` skips the save; on conversation
 * load, a trailing message that fails this predicate is also self-
 * healed out of chatDb so previously-broken chats recover automatically.
 */
export function hasMeaningfulContent(parts: SerializedUIPart[]): boolean {
  return parts.some((p) => {
    if (p.type === "text" || p.type === "reasoning") return p.text.length > 0;
    if (p.type === "dynamic-tool") return true;
    if (p.type === "file" || p.type === "source-url") return true;
    // step-start and data-compaction are markers, not user-visible content.
    return false;
  });
}
