import type { AgentUIMessage } from "@/lib/types";

type AgentMessage = AgentUIMessage;

/**
 * Heals "stranded" tool calls in `messages` so a subsequent prompt does not
 * trip the AI SDK's `MissingToolResultsError`, the Anthropic "tool_use
 * without tool_result" rejection, or MCP input-schema validation.
 *
 * The healer recognizes "terminal" states by inclusion (states that already
 * carry an `output`/`errorText` and survive the round-trip through
 * `convertToModelMessages`). Anything else is non-terminal and gets healed:
 *
 * - `approval-requested` → `output-denied` (approval.approved = false).
 * - denied `approval-responded` (approved === false) → `output-denied`.
 * - approved `approval-responded` (approved === true) → `output-error`.
 *   This is deliberate: by the time `healPendingTools` runs, a user message
 *   is about to be appended (or history sliced), so the approved call is no
 *   longer the last message and the SDK's `collectToolApprovals` (which only
 *   inspects `messages.at(-1)`) can NEVER resume it. Leaving it as
 *   `approval-responded` produces a `tool_use` with no `tool_result` →
 *   Anthropic 400. (The legitimate auto-resume path runs through the SDK's
 *   `sendAutomaticallyWhen` and never calls this function; the transport's
 *   `repairToolPart` still preserves approved calls for that path.)
 * - any other non-terminal/unrecognized state → `output-error`.
 *
 * Input handling: a real `input` is preserved, but a MISSING input is left
 * undefined — never synthesized to `{}`. Synthesizing `{}` caused MCP tools
 * to fail `validateUIMessages` ("Type validation failed ... path: ['list']"):
 * the SDK schema-validates an `output-error` part's input only when it is
 * `!== undefined`, and an empty object fails a schema with required fields.
 * NOTE: `convertToModelMessages` emits a `tool-call` with `input: undefined`
 * for such a part, and the PROVIDER rejects that (Anthropic/Bedrock
 * `tool_use.input: Field required`; Gemini silent malformed-call error). This
 * persistence-level heal therefore does NOT make an input-less interrupted
 * call safe to send on its own — the send-time transport heal
 * (`repairToolPart`) DROPS input-less interrupted calls before they reach the
 * provider. Keeping the persisted/UI copy lets the user still see the
 * "Interrupted" badge.
 *
 * Returns both the new full `messages` list and the subset that actually
 * changed. Callers persist the changed subset to chatDb so the heal survives
 * across reloads.
 */
export const TOOL_HEAL_INTERRUPT_TEXT =
  "Tool execution was interrupted before it returned a result";

/**
 * Tool-part states that already carry the data `convertToModelMessages`
 * needs to emit a valid model message. Anything outside this set is
 * non-terminal and must be healed before the messages are sent to the model.
 */
const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

export function healPendingTools(
  messages: AgentMessage[],
  denyReason: string,
): { healed: AgentMessage[]; healedMessages: AgentMessage[] } {
  const isToolPart = (p: unknown): boolean => {
    const pp = p as Record<string, unknown>;
    return (
      pp.type === "dynamic-tool" ||
      (typeof pp.type === "string" &&
        (pp.type as string).startsWith("tool-"))
    );
  };

  const needsHeal = (p: unknown): boolean => {
    if (!isToolPart(p)) return false;
    const pp = p as Record<string, unknown>;
    const state = pp.state;
    if (typeof state !== "string") return true;
    // `approval-responded` is non-terminal. The SDK can only re-execute an
    // approved call when it is in the LAST (tool-role) message — see
    // `collectToolApprovals`, which inspects only `messages.at(-1)`. Every
    // caller of `healPendingTools` is about to append a user message (new
    // submit / queued / continue / retry) or slice history (edit), after
    // which the approved call is no longer last and the SDK will NEVER
    // resume it. Leaving it as `approval-responded` then makes
    // convertToModelMessages emit a `tool_use` with no matching
    // `tool_result` → Anthropic rejects the request ("tool_use ids were
    // found without tool_result blocks"). So here we DO heal an approved,
    // output-less call (folded to output-error below) to guarantee a paired
    // result. (The legitimate auto-resume path goes through
    // `sendAutomaticallyWhen` and never calls this function; the send-time
    // `repairToolPart` still preserves approved calls for that path.)
    if (state === "approval-responded") {
      return true;
    }
    if (!TERMINAL_TOOL_STATES.has(state)) return true;

    // A terminal part is valid as-is even with no `input` — the SDK's
    // convertToModelMessages tolerates undefined input on errored/denied
    // parts, and validateUIMessages SKIPS schema validation for output-error
    // when input is undefined. So missing input alone does NOT require heal.
    if (state === "output-available") {
      return pp.output === undefined || pp.output === null;
    }
    if (state === "output-error") {
      return typeof pp.errorText !== "string" || pp.errorText.length === 0;
    }
    if (state === "output-denied") {
      const ap = pp.approval as
        | { id?: unknown; approved?: unknown }
        | undefined;
      // Strict denial shape: must have a string id AND `approved`
      // explicitly false. `approved: true` paired with state
      // `output-denied` is contradictory and gets healed.
      return !(
        ap && typeof ap.id === "string" && ap.approved === false
      );
    }
    return false;
  };

  const anyPending = messages.some((m) => m.parts.some(needsHeal));
  if (!anyPending) return { healed: messages, healedMessages: [] };

  const healedMessages: AgentMessage[] = [];
  const healed = messages.map((msg) => {
    let changed = false;
    const newParts = msg.parts.map((part) => {
      if (!needsHeal(part)) return part;
      const p = part as Record<string, unknown>;
      const state = typeof p.state === "string" ? p.state : undefined;

      // Preserve a real `input` if the part has one; otherwise set it to
      // `undefined`. Two constraints from the SDK shape this:
      //  - The structural UIMessage schema requires the `input` KEY to be
      //    present on tool parts (zod `z.unknown()` here rejects a missing
      //    key), so we must always include it.
      //  - But we must NOT substitute `{}`: validateUIMessages schema-checks
      //    an output-error part's input only when it is `!== undefined`, so
      //    `{}` is run against the tool's (possibly strict, e.g. MCP) schema
      //    and fails its required fields ("Type validation failed ...
      //    path: ['list']"). `undefined` makes the SDK skip that check, and
      //    convertToModelMessages tolerates undefined input on errored/denied
      //    tool-calls.
      // So: key always present, value is the real input or `undefined`.
      const hasInput = p.input !== undefined && p.input !== null;
      const input = hasInput ? p.input : undefined;

      // approval-requested keeps its dedicated path so the UI's
      // "denied" affordance renders consistently with explicit
      // user-deny actions. Validate the approval id is a real string
      // before trusting it; malformed approvals fall through to the
      // default output-error heal below.
      if (state === "approval-requested" && p.approval) {
        const approval = p.approval as { id?: unknown };
        if (typeof approval.id === "string") {
          changed = true;
          return {
            ...part,
            input,
            state: "output-denied",
            approval: { id: approval.id, approved: false, reason: denyReason },
          } as typeof part;
        }
      }

      // A denied `approval-responded` (approved === false) folds to the
      // canonical output-denied terminal shape, preserving the user's
      // reason. (An approved one is also healed now — see needsHeal — but
      // takes the default output-error branch below so it gets a paired
      // tool_result, since the SDK can no longer resume it.)
      if (state === "approval-responded" && p.approval) {
        const approval = p.approval as {
          id?: unknown;
          approved?: unknown;
          reason?: unknown;
        };
        if (typeof approval.id === "string" && approval.approved === false) {
          changed = true;
          return {
            ...part,
            input,
            state: "output-denied",
            approval: {
              id: approval.id,
              approved: false,
              reason:
                typeof approval.reason === "string"
                  ? approval.reason
                  : denyReason,
            },
          } as typeof part;
        }
      }

      // Default heal: every other malformed/non-terminal case (including an
      // approved-but-unresumable approval-responded) becomes output-error.
      // Strip any partial `output` so errorText is the sole signal, and set
      // `input` to the real value or `undefined` (never `{}` — see above).
      const { output: _output, input: _input, ...rest } = part as {
        output?: unknown;
        input?: unknown;
      } & Record<string, unknown>;
      void _output;
      void _input;
      changed = true;
      const errorText =
        state === "output-error" &&
        typeof p.errorText === "string" &&
        p.errorText.length > 0
          ? p.errorText
          : TOOL_HEAL_INTERRUPT_TEXT;
      return {
        ...rest,
        input,
        state: "output-error",
        errorText,
      } as typeof part;
    });
    if (!changed) return msg;
    const newMsg = { ...msg, parts: newParts };
    healedMessages.push(newMsg);
    return newMsg;
  });

  return { healed, healedMessages };
}
