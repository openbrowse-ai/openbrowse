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
