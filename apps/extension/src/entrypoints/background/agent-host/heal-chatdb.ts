/**
 * SW-side heal for stranded tool parts in chat-db.
 *
 * The SW agent host's run terminates in several ways:
 *
 *   1. Natural completion — the for-await loop drains, persister wrote
 *      the final assistant message with terminal tool states.
 *   2. Explicit stop — `chat.stop()` / Esc Esc / Stop button → abort
 *      signal → `for await` body's `if (signal.aborted) break;` exits.
 *      The LAST persisted message can have a tool in `input-streaming`
 *      or `input-available` (model was mid-arguments-emit, hadn't
 *      reached output yet).
 *   3. Provider error mid-stream — the `Promise.all([fanout, message])`
 *      catch branch fires; the persister's last write may be partial.
 *   4. SW crash / port disconnect — persister may not have flushed the
 *      latest chunk.
 *
 * Renderer-side `healPendingTools` runs on the NEXT user action
 * (submit / queued drain / continue / retry). It heals the in-memory
 * `messages` and writes the changed messages back to chat-db. But:
 *
 *   - If the user never acts again (closes tab, reload, dropped session)
 *     the chat-db row stays stranded.
 *   - The UI considers a chat with a non-terminal tool part as "loading"
 *     forever (spinner + stop button stuck enabled).
 *
 * This SW-side heal closes that gap: at run termination we read the
 * last persisted assistant message, apply the same heal semantics
 * (mirrored from `heal-pending-tools.ts`), and write back if anything
 * changed. Symmetric to renderer heal; needed because the renderer's
 * heal is gated on a user action that may never come.
 *
 * Operates directly on `SerializedUIPart[]` (the chat-db encoding) to
 * avoid the deserialize-then-serialize round-trip. ALL tool parts in
 * chat-db have `type: "dynamic-tool"` (see `serialize-parts.ts`
 * fallback branch that normalizes `tool-X` types).
 */

import type { SerializedUIPart } from "@/lib/agent/message-types";
import { TOOL_HEAL_INTERRUPT_TEXT } from "@/lib/agent/heal-pending-tools";
import { chatDb } from "@/lib/chat-db";

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

export interface HealResult {
  parts: SerializedUIPart[];
  changed: boolean;
}

/**
 * Walk the parts array and heal any non-terminal tool parts. Returns
 * `{changed: false, parts: <same ref>}` when nothing needed healing so
 * callers can skip the chat-db write.
 *
 * Heal targets (mirroring `healPendingTools`):
 *
 *   - `approval-requested` → `output-denied` (approval.approved = false)
 *   - `approval-responded`:
 *       - approved=false → `output-denied`
 *       - approved=true OR missing → `output-error` (SDK can no longer
 *         resume; emit a paired result so the next user message doesn't
 *         trip "tool_use without tool_result").
 *   - Any other non-terminal state → `output-error` with
 *     `TOOL_HEAL_INTERRUPT_TEXT`.
 *
 * Inputs on healed parts are PRESERVED (a real input is kept on the
 * heal output). Missing input is left undefined — never synthesized to
 * `{}` (would fail MCP tool input schemas with required fields, see
 * `heal-pending-tools.ts:28`).
 */
export function healSerializedParts(parts: SerializedUIPart[]): HealResult {
  let changed = false;
  const out: SerializedUIPart[] = [];
  for (const part of parts) {
    if (part.type !== "dynamic-tool") {
      out.push(part);
      continue;
    }
    const state = (part as { state: string }).state;
    if (TERMINAL_TOOL_STATES.has(state)) {
      out.push(part);
      continue;
    }

    changed = true;

    // approval-requested → output-denied
    if (state === "approval-requested") {
      const approval = (part as { approval?: { id: string } }).approval;
      out.push({
        ...part,
        state: "output-denied",
        approval: approval
          ? { id: approval.id, approved: false }
          : undefined,
      } as SerializedUIPart);
      continue;
    }

    // approval-responded — depends on the user's choice
    if (state === "approval-responded") {
      const approval = (part as { approval?: { approved?: boolean } })
        .approval;
      // Distinguish three sub-cases:
      //   - approved === false → user explicitly denied; heal to
      //     `output-denied` so the next turn surfaces the denial.
      //   - approved === true → user approved but the run terminated
      //     before the SDK could execute the tool; heal to
      //     `output-error` with the interrupt text so the provider's
      //     tool_use block still has a paired result.
      //   - missing/undefined approval → unknown / interrupted; treat
      //     the same as approved-but-interrupted (output-error) rather
      //     than collapsing into denied. The previous behavior
      //     (`if (!approved)` → denied) conflated "denied" and
      //     "interrupted before responding", which is misleading.
      if (approval?.approved === false) {
        out.push({
          ...part,
          state: "output-denied",
        } as SerializedUIPart);
        continue;
      }
      // approved === true OR approval missing → output-error.
      out.push({
        ...part,
        state: "output-error",
        errorText: TOOL_HEAL_INTERRUPT_TEXT,
      } as SerializedUIPart);
      continue;
    }

    // input-streaming, input-available, or any unknown non-terminal
    // → output-error with the interrupted text.
    out.push({
      ...part,
      state: "output-error",
      errorText: TOOL_HEAL_INTERRUPT_TEXT,
    } as SerializedUIPart);
  }

  if (!changed) {
    return { parts, changed: false };
  }
  return { parts: out, changed: true };
}

/**
 * Read the LAST assistant message for `conversationId` and heal any
 * stranded tool parts in place. Idempotent: if the message is already
 * terminal, no chat-db write happens.
 *
 * Intended to be called from the SW agent host's `run.ts` finally
 * block so every termination path (completion, abort, error,
 * disconnect) leaves chat-db in a terminal state — and the UI's
 * stuck-loading-spinner symptom that survived reload goes away.
 *
 * Best-effort: any thrown error is swallowed and reported via the
 * optional `onError` hook so the finally-block can't block run cleanup.
 */
export async function healLastAssistantInChatDb(
  conversationId: string,
  options: { onError?: (err: unknown) => void } = {},
): Promise<{ healed: boolean }> {
  try {
    const msgs = await chatDb.getMessages(conversationId);
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) return { healed: false };
    const target = msgs[lastAssistantIdx];
    const { parts, changed } = healSerializedParts(target.parts);
    if (!changed) return { healed: false };
    await chatDb.saveMessages([
      {
        ...target,
        parts,
      },
    ]);
    return { healed: true };
  } catch (err) {
    options.onError?.(err);
    return { healed: false };
  }
}
