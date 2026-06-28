import type { AgentUIMessage } from "@/lib/types";

/**
 * Whether to mount the standalone `<ThinkingIndicator>` at the end of
 * the message list.
 *
 * The trailing indicator is meant to fill the visual gap between
 * "user pressed Send" and "first chunk arrived, mounting the
 * assistant bubble with its own `<GeneratingIndicator>`". Once the
 * assistant row exists, the row's own indicator covers the gap, and
 * the list-level indicator would render alongside it as a duplicate
 * blue sparkle.
 *
 * Previously this was gated on `isLoading && !hookIsStreaming`. That
 * worked on the **initiator** surface, where `hookIsStreaming` flips
 * true as soon as the local `useChat` reads its first chunk. It
 * BROKE on **viewer** surfaces (a second open of the same
 * conversation while another surface drives the run): on a viewer,
 * `useChat.status` never enters `streaming` (no local transport
 * activity), so `hookIsStreaming` is always false, and `isLoading`
 * is true (from `isAgentActiveGlobally`). The trailing indicator
 * therefore showed for the duration of the entire SW-hosted run,
 * stacking with the per-assistant `<GeneratingIndicator>` and
 * producing two pulsing blue sparkles.
 *
 * The corrected invariant is structural rather than status-based:
 *
 *     show the trailing indicator iff the run is active AND the
 *     last message in the visible list is not yet an assistant row.
 *
 * This is correct on every surface:
 *
 *  - Initiator, submitted but no chunks yet: last message is the
 *    user's input -> trailing indicator shows. (Same behavior as
 *    before, no regression.)
 *  - Initiator, streaming: last message is the in-flight assistant
 *    row -> trailing indicator hidden; the assistant row's own
 *    `<GeneratingIndicator>` is the single source of truth.
 *  - Viewer with snapshots arriving: last message is the mirrored
 *    assistant row -> trailing indicator hidden. (Fix.)
 *  - Viewer with run active but no snapshot yet (no STREAM_PARTS
 *    has landed for the new turn): last message is the user's input
 *    -> trailing indicator shows. (Correct — bridges the same gap
 *    we cover for the initiator.)
 *
 * `lastMessage?.role !== "assistant"` (rather than `messages.some`)
 * is load-bearing: a continuation turn always has earlier assistant
 * rows in the history, but we still want the gap-filler for the new
 * user message until the new assistant row exists.
 */
export function computeShowThinking(
  isLoading: boolean,
  messages: Pick<AgentUIMessage, "role">[],
): boolean {
  if (!isLoading) return false;
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.role !== "assistant";
}
