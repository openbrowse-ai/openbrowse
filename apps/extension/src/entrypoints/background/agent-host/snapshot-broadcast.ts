/**
 * SW-side throttled `STREAM_PARTS` / `STREAM_DONE` broadcaster.
 *
 * Lifts the renderer-side broadcaster (formerly the
 * `useAgentChat.ts:1290-1319` effect) into the service worker so the SW
 * agent host can fan out display-state snapshots to renderer surfaces
 * that joined late or were frozen mid-run.
 *
 * Semantics match the prior renderer behavior:
 *   - The first emit fires immediately (leading edge).
 *   - Subsequent emits inside the throttle window are coalesced; one
 *     trailing-edge call lands after the window closes, carrying the
 *     latest payload. This guarantees the final partial state ships
 *     even if updates stop arriving mid-window.
 *   - `seq` is monotonically increasing per broadcaster instance so
 *     viewers can drop out-of-order frames (`SeqGuard` in
 *     `stream-mirror.ts`).
 *   - `done()` flushes any pending trailing emit, then issues a
 *     `STREAM_DONE`. Idempotent.
 */

import {
  broadcastStreamDone,
  broadcastStreamParts,
} from "@/lib/agent/stream-mirror";
import type { SerializedUIPart } from "@/lib/agent/message-types";
import { STREAM_MIRROR_THROTTLE_MS } from "@/lib/constants";

export interface SnapshotEmit {
  messageId: string;
  parts: SerializedUIPart[];
}

export interface SnapshotBroadcaster {
  emit(snapshot: SnapshotEmit): void;
  done(): void;
}

export function createSnapshotBroadcaster(
  conversationId: string,
  throttleMs: number = STREAM_MIRROR_THROTTLE_MS,
): SnapshotBroadcaster {
  let seq = 0;
  let lastEmitAt = 0;
  let pending: SnapshotEmit | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let isDone = false;

  function fire(snapshot: SnapshotEmit): void {
    seq += 1;
    lastEmitAt = Date.now();
    broadcastStreamParts({
      conversationId,
      messageId: snapshot.messageId,
      parts: snapshot.parts,
      seq,
    });
  }

  function flushPendingNow(): void {
    if (pendingTimer != null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pending != null) {
      const snap = pending;
      pending = null;
      fire(snap);
    }
  }

  return {
    emit(snapshot: SnapshotEmit): void {
      if (isDone) return;
      const now = Date.now();
      const elapsed = now - lastEmitAt;
      if (lastEmitAt === 0 || elapsed >= throttleMs) {
        // Leading edge: emit immediately, drop any earlier pending payload.
        if (pendingTimer != null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        pending = null;
        fire(snapshot);
        return;
      }
      // Inside the throttle window: replace any pending payload (latest
      // wins) and ensure a trailing-edge timer is scheduled.
      pending = snapshot;
      if (pendingTimer == null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          flushPendingNow();
        }, throttleMs - elapsed);
      }
    },

    done(): void {
      if (isDone) return;
      isDone = true;
      flushPendingNow();
      broadcastStreamDone(conversationId);
    },
  };
}
