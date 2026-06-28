import type { SerializedUIPart } from "./message-types";
import { RUNTIME_MESSAGES } from "@/lib/constants";

/**
 * Host → viewer streaming mirror.
 *
 * The live agent loop runs in exactly one context (the host). Other open
 * contexts on the same conversation are "viewers" that cannot see the
 * host's in-memory stream. This module ships throttled, full-message
 * snapshots of the in-flight assistant message from the host to viewers
 * over `chrome.runtime.sendMessage` so viewers can mirror progress live.
 *
 * Full snapshots (not deltas) are used on purpose: a single frame fully
 * catches up a late-joining viewer and self-heals any dropped frame, at
 * the cost of slightly larger messages. A monotonic `seq` lets viewers
 * discard stale/out-of-order frames.
 *
 * `chrome.runtime.sendMessage` does not echo back to its sender, so the
 * host never receives its own frames — exactly what we want (the host
 * renders from its own live `messages`).
 */

export interface StreamPartsMessage {
  type: typeof RUNTIME_MESSAGES.STREAM_PARTS;
  conversationId: string;
  messageId: string;
  parts: SerializedUIPart[];
  seq: number;
}

export interface StreamDoneMessage {
  type: typeof RUNTIME_MESSAGES.STREAM_DONE;
  conversationId: string;
}

/** Broadcast a full-message snapshot to viewer contexts. */
export function broadcastStreamParts(msg: {
  conversationId: string;
  messageId: string;
  parts: SerializedUIPart[];
  seq: number;
}): void {
  const payload: StreamPartsMessage = {
    type: RUNTIME_MESSAGES.STREAM_PARTS,
    ...msg,
  };
  try {
    chrome.runtime?.sendMessage?.(payload)?.catch?.(() => {});
  } catch {
    /* non-extension context; ignore */
  }
}

/** Broadcast that a turn reached a terminal state. */
export function broadcastStreamDone(conversationId: string): void {
  const payload: StreamDoneMessage = {
    type: RUNTIME_MESSAGES.STREAM_DONE,
    conversationId,
  };
  try {
    chrome.runtime?.sendMessage?.(payload)?.catch?.(() => {});
  } catch {
    /* non-extension context; ignore */
  }
}

export function isStreamPartsMessage(
  msg: unknown,
): msg is StreamPartsMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<StreamPartsMessage>;
  return (
    m.type === RUNTIME_MESSAGES.STREAM_PARTS &&
    typeof m.conversationId === "string" &&
    typeof m.messageId === "string" &&
    typeof m.seq === "number" &&
    Array.isArray(m.parts)
  );
}

export function isStreamDoneMessage(
  msg: unknown,
): msg is StreamDoneMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<StreamDoneMessage>;
  return (
    m.type === RUNTIME_MESSAGES.STREAM_DONE &&
    typeof m.conversationId === "string"
  );
}

/**
 * Pure merge of a mirrored snapshot into a viewer's message list.
 *
 * Replaces the assistant message with `snapshot.id` if present, otherwise
 * appends it at the tail. The snapshot is a full assistant message, so
 * the latest frame is always the complete current state.
 *
 * Generic over the message shape so it can run against AI SDK
 * `UIMessage`s in the hook and plain objects in tests.
 */
export function applyStreamSnapshot<
  M extends { id: string; role: string },
>(messages: M[], snapshot: M): M[] {
  const idx = messages.findIndex((m) => m.id === snapshot.id);
  if (idx === -1) return [...messages, snapshot];
  const next = messages.slice();
  next[idx] = snapshot;
  return next;
}

/**
 * Reconcile a renderer's in-memory `messages` array with the persisted
 * chatDb state after a turn terminates.
 *
 * Use case: the user clicks Stop and immediately sends a new message.
 * The side panel (initiator) has accumulated in-memory stream chunks
 * for the aborted assistant message, and may have an in-flight new
 * assistant message for the next turn already streaming. We need to:
 *
 *   1. Replace the pre-existing messages with chatDb's canonical
 *      (post-heal, post-persister) versions. This converges the
 *      aborted message with whatever the SW persister + the
 *      renderer's `healPendingTools` write committed.
 *   2. PRESERVE local messages whose ids are NOT in chatDb yet — those
 *      are the brand-new user message and the in-progress assistant
 *      message for the next turn. Clobbering them would erase the
 *      live stream the user is watching.
 *
 * Strategy: take chatDb's messages as the base; append any local
 * messages whose ids are not in chatDb. Order: chatDb messages come
 * first (their order is authoritative for the historical transcript),
 * then local-only messages in their original local order (they're the
 * tail of the new turn).
 */
export function mergeChatDbWithLocal<
  M extends { id: string; role: string },
>(dbMessages: M[], localMessages: M[]): M[] {
  const dbIds = new Set(dbMessages.map((m) => m.id));
  const localOnly = localMessages.filter((m) => !dbIds.has(m.id));
  return [...dbMessages, ...localOnly];
}

/**
 * Tracks the highest `seq` applied per message id so a viewer can drop
 * stale/out-of-order frames. Returns true if the frame should be applied.
 */
export class SeqGuard {
  private readonly seen = new Map<string, number>();

  shouldApply(messageId: string, seq: number): boolean {
    const last = this.seen.get(messageId);
    if (last !== undefined && seq <= last) return false;
    this.seen.set(messageId, seq);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * Watchdog decision: should the initiator renderer recover from a
 * stuck-streaming state by force-rehydrating from chatDb and resetting
 * its local Chat status?
 *
 * Context: the AI SDK's `Chat` instance drives the streaming lifecycle
 * in the renderer. Under SW-host the actual model loop runs in the SW
 * and chunks flow back via a `chrome.runtime.connect` port. If the port
 * gets disrupted (browser internals, message-passing edge cases, the
 * SW finished but the DONE chunk never made it back), `Chat.status`
 * stays at `streaming` indefinitely. Consequences:
 *
 *   - Queue auto-flush gates on `status === "ready"` and never drains.
 *   - The UI shows perpetual "Navigating..." or similar tool-running
 *     indicator.
 *   - The viewer watchdog (see useAgentChat.ts) does NOT help: that
 *     watchdog only fires for viewer renderers, not the initiator.
 *
 * This is the symmetric initiator-side recovery: if the local Chat has
 * been "streaming" or "submitted" for longer than `idleThresholdMs`
 * since the last chunk activity AND chatDb's last assistant message
 * shows a clean terminal state (no in-flight tool inputs, no pending
 * approval), force convergence with chatDb.
 *
 * Returns `false` (skip recovery) in any of these cases — each is a
 * legitimate non-stuck state we shouldn't disrupt:
 *
 *   - `status` is `ready` or `error` — no stuck state to recover.
 *   - `now - lastActivityMs <= idleThresholdMs` — recent activity, the
 *     run might just be slow.
 *   - `dbLastAssistantParts` is `undefined` — we have no chatDb signal
 *     to converge against; better to wait than to clobber an empty
 *     turn record.
 *   - Any tool part is in `input-streaming` state — the tool's
 *     arguments are still being built; the model is genuinely mid-flight.
 *   - Any tool part is in `approval-requested` state — the user is
 *     intentionally paused awaiting action; recovery here would discard
 *     the approval prompt.
 *
 * All time arithmetic uses an open interval (`>` not `>=`) for the
 * threshold so a test that schedules recovery for exactly the threshold
 * doesn't fire on the edge.
 */
export function shouldRecoverFromStuckStreaming(args: {
  status: "ready" | "submitted" | "streaming" | "error";
  lastActivityMs: number;
  now: number;
  idleThresholdMs: number;
  /**
   * The `parts` array of the last assistant message in chatDb, or
   * `undefined` if chatDb has no assistant message yet. Used to decide
   * whether the run actually finished (clean terminal state) versus
   * being genuinely mid-flight or paused on approval.
   *
   * Only the `state` field is read; extra fields on each part (text,
   * input, output, etc.) are accepted but ignored.
   */
  dbLastAssistantParts?: ReadonlyArray<{
    type: string;
    state?: string;
    [key: string]: unknown;
  }>;
}): boolean {
  // Only stuck if Chat thinks a run is in progress.
  if (args.status !== "streaming" && args.status !== "submitted") {
    return false;
  }
  // Must be idle past the threshold (open interval).
  if (args.now - args.lastActivityMs <= args.idleThresholdMs) {
    return false;
  }
  // Need a chatDb signal to converge against.
  if (!args.dbLastAssistantParts) {
    return false;
  }
  // Bail if any part indicates "genuinely mid-flight" or "user must act".
  // The full bail set:
  //   - "input-streaming": tool input still being built by the model
  //   - "input-available": input complete, tool execution dispatched
  //     but no output yet; converging would discard the in-flight call
  //   - "approval-requested": INTENTIONAL pause waiting on user action
  //   - "approval-responded": user just responded; SDK is resuming and
  //     output hasn't materialised yet
  //
  // All four are non-terminal: converging the local message list to
  // the db snapshot would clobber state the SW is still producing.
  // Terminal states ("output-available", "output-error",
  // "output-denied") are safe to converge against and trigger the
  // recovery.
  for (const part of args.dbLastAssistantParts) {
    if (part.state === "input-streaming") return false;
    if (part.state === "input-available") return false;
    if (part.state === "approval-requested") return false;
    if (part.state === "approval-responded") return false;
  }
  return true;
}
