import {
  convertToModelMessages,
  validateUIMessages,
  type Agent,
  type ChatTransport,
  type InferUITools,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { AgentDataParts, AgentUIMessage, CompactionPart } from "../types";
import {
  COMPACTION_USER_PROMPT,
  SCREENSHOT_PROTECTED_TURNS,
  findProtectedTailStart,
  keepOnlyLatestScreenshot,
  keepOnlyLatestSnapshotPerTab,
  prunePartsAtSendTime,
  stripScreenshotsFromParts,
} from "./compaction";
import { isPlainObject, normalizeToolInput } from "./tool-input-normalize";
import {
  runCompletionCheck,
  shouldGate,
  type RunCompletionCheckInput,
} from "./completion-check";
import type {
  ConcernDimension,
  EvaluatorVerdict,
  GateOutcome,
  ToolCallTraceEntry,
} from "./completion-check/types";
import {
  TRACE_INPUT_TRUNCATE_CHARS,
  TRACE_OUTPUT_TRUNCATE_CHARS,
} from "./completion-check/types";

interface Options<TOOLS extends ToolSet> {
  agent: Agent<never, TOOLS, never>;
  /**
   * Called once at the top of each `sendMessages`. The agent layer uses
   * this to clear the per-stream "needs mid-stream compaction" signal so
   * the next step's onStepFinish can re-trigger it cleanly.
   */
  onSendStart?: () => void;
  /**
   * When true, every `sendMessages` call strips all but the most recent
   * page-screenshot tool result from the message history, regardless of
   * user-turn boundaries. Used by the bench harness — bench trials have
   * a single user turn (the task instruction), so the default user-turn
   * protected-tail policy never strips anything in bench, leading to
   * context bloat from accumulated screenshots. The extension agent runs
   * with this off (default) so users keep multi-turn visual recall.
   */
  keepOnlyLatestImage?: boolean;
  /**
   * Tool names whose output is a page-state image, for the
   * `keepOnlyLatestImage` policy. Defaults to the module's
   * `PAGE_SCREENSHOT_TOOLS` (`["screenshot"]`). Headless harnesses pass their
   * own page-state image tool names (e.g. `["viewPage"]`) so the public
   * extension never hardcodes experiment tool names.
   */
  screenshotToolNames?: string[];
  /**
   * Snapshot the active conversation id at the moment `sendMessages` is
   * invoked. The transport captures this synchronously at the top of
   * `sendMessages` and threads it through to `buildCompletionCheckInput`
   * so the gate's chatDb reads (todos lookup, telemetry) target the
   * conversation that started the loop, even if the user switches
   * conversations mid-stream.
   *
   * Decoupled as a getter rather than a constructor value because the
   * transport instance is shared across conversations within a space —
   * pinning at construction would tie one transport to one cid forever.
   */
  getActiveConversationId?: () => string | null;
  /**
   * Constructs the input for the completion-check gate after each agent
   * iteration finishes. Called once per iteration with the messages as
   * they were when that iteration started, plus the iteration's
   * accumulated final-text and tool-call trace, plus the cid pinned at
   * `sendMessages` entry.
   *
   * The transport uses the returned input to run `runCompletionCheck`.
   * On a rejection verdict (within the budget), it appends a synthetic
   * completion-check-feedback user message to the local message list and
   * re-runs the agent. On approve / skip / force-emit / max-rounds, the
   * loop exits and the stream closes.
   *
   * Returning `undefined` means "no gate configured for this run" — the
   * loop runs exactly one agent iteration and exits, identical to the
   * pre-gate behavior.
   *
   * Async because the builder typically reads conversation state (e.g.
   * todos) from IndexedDB.
   */
  buildCompletionCheckInput?: (args: {
    sendMessages: AgentUIMessage[];
    finalText: string;
    toolCallTrace: ToolCallTraceEntry[];
    pinnedConversationId: string | null;
  }) =>
    | Promise<RunCompletionCheckInput | undefined>
    | RunCompletionCheckInput
    | undefined;

  /**
   * Callback fired when the CompletionCheck evaluator approves a final
   * response. Allows the host environment (e.g. the Chrome extension)
   * to persist completion state without coupling this module to platform-
   * specific storage APIs.
   */
  onCompletionCheckApproved?: (
    conversationId: string,
    now: number,
  ) => void | Promise<void>;
}

/**
 * A `ChatTransport` wrapper that applies auto-compaction at send time.
 *
 * Compaction events live as messages in the chat history (a user message
 * carrying a `CompactionPart`, immediately followed by an assistant
 * message containing the summary text). For every outbound request:
 *
 * 1. Walk the message list to find the latest completed compaction event
 *    (compaction-user immediately followed by an assistant whose first
 *    part-pair signature matches a summary). If found, drop the head and
 *    keep `[compaction-user, summary, ...retained-tail, ...post-event]`.
 *    The retained tail is anchored at `compactionPart.tailStartMessageId`
 *    when set; otherwise it falls back to "everything after the
 *    compaction event."
 * 2. Substitute the `CompactionPart` with a synthetic user text
 *    ("What did we do so far?") so the model sees a normal Q/A flow:
 *    user asks, assistant summarizes, user (auto-continue) says "continue
 *    where you left off."
 * 3. Apply per-part pruning (truncate oversized tool outputs, drop
 *    screenshot data) so even the live tail can't ship hundreds of KB of
 *    stale payload.
 * 4. We skip `DirectChatTransport` and manually convert and stream via the
 *    underlying Agent. `DirectChatTransport`'s class signature constrains
 *    `UI_MESSAGE extends UIMessage<unknown, never, ...>` — i.e. forbids any
 *    extended `DATA_PARTS` — which would reject our `AgentDataParts`.
 *    Inlining the four-line equivalent (validate → convert → stream →
 *    toUIMessageStream) lets us flow `AgentUIMessage` end-to-end without
 *    type assertions.
 *
 * The Chat instance's in-memory messages are never mutated — the UI keeps
 * showing the full conversation; only what the LLM sees is compacted.
 *
 * If no compaction events exist, the wrapper still applies send-time
 * pruning (idempotent, near-zero overhead for short conversations).
 *
 * @typeParam TOOLS - The agent's tool set; flows through to
 *   `validateUIMessages` so tool-call shapes are validated against the
 *   agent's actual tools at the type level. Mirrors `DirectChatTransport`'s
 *   `TOOLS` parameter.
 */
export class CompactingChatTransport<TOOLS extends ToolSet = ToolSet>
  implements ChatTransport<AgentUIMessage>
{
  private readonly agent: Agent<never, TOOLS, never>;
  private readonly onSendStart?: () => void;
  private readonly keepOnlyLatestImage: boolean;
  private readonly screenshotToolNames?: Set<string>;
  private readonly getActiveConversationId?: () => string | null;
  private readonly buildCompletionCheckInput?: Options<TOOLS>["buildCompletionCheckInput"];
  private readonly onCompletionCheckApproved?: Options<TOOLS>["onCompletionCheckApproved"];

  constructor({
    agent,
    onSendStart,
    keepOnlyLatestImage,
    screenshotToolNames,
    getActiveConversationId,
    buildCompletionCheckInput,
    onCompletionCheckApproved,
  }: Options<TOOLS>) {
    this.agent = agent;
    this.onSendStart = onSendStart;
    this.keepOnlyLatestImage = keepOnlyLatestImage ?? false;
    this.screenshotToolNames = screenshotToolNames
      ? new Set(screenshotToolNames)
      : undefined;
    this.getActiveConversationId = getActiveConversationId;
    this.buildCompletionCheckInput = buildCompletionCheckInput;
    this.onCompletionCheckApproved = onCompletionCheckApproved;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: {
    messages: AgentUIMessage[];
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk>> {
    this.onSendStart?.();
    const buildCompletionCheckInput = this.buildCompletionCheckInput;
    const onCompletionCheckApproved = this.onCompletionCheckApproved;
    const pinnedConversationId = this.getActiveConversationId?.() ?? null;
    let rewritten = rewriteForLLM(messages, this.agent.tools);
    if (this.keepOnlyLatestImage) {
      rewritten = keepOnlyLatestScreenshot(rewritten, this.screenshotToolNames);
    }
    // Always keep only the latest accessibility snapshot per tab. Older
    // snapshots' @refs are invalid by construction (reassigned on every
    // capture) and the agent is told to re-snapshot, so retaining their
    // multi-kilobyte trees only bloats context. Unlike screenshots this is
    // unconditional — there is no scenario where a stale snapshot tree is
    // worth its token cost.
    rewritten = keepOnlyLatestSnapshotPerTab(rewritten);

    // Tie validateUIMessages' inferred UI_MESSAGE to *this transport's*
    // TOOLS so its `tools` parameter resolves to the same shape as
    // `agent.tools` (i.e. the precise tools the agent was constructed
    // with). Without this hint TS defaults to the wide `UITools` map and
    // rejects the assignment.
    type ToolBoundUIMessage = UIMessage<
      unknown,
      AgentDataParts,
      InferUITools<TOOLS>
    >;
    const validatedMessages = await validateUIMessages<ToolBoundUIMessage>({
      messages: rewritten,
      tools: this.agent.tools,
    });

    // Fast path: no gate configured. One agent iteration, no rejection
    // loop, no observation overhead. Identical behavior to pre-Phase-1.
    if (!this.buildCompletionCheckInput) {
      const modelMessages = await convertModelMessagesWithDiag(
        validatedMessages,
        this.agent.tools,
        "transport.fast-path",
      );
      assertModelMessageToolInputs(modelMessages, "transport.fast-path");
      try {
        const result = await this.agent.stream({
          prompt: modelMessages,
          abortSignal,
        });
        return result.toUIMessageStream({
          // Pass the validated input messages so the SDK's
          // `getResponseUIMessageId` (ai/dist/index.mjs:5081-5090) can
          // reuse the LAST assistant message's id when present —
          // converting an approval resume into a continuation of the
          // existing assistant turn instead of a new bubble. Without
          // this, our `generateMessageId` callback below was minting a
          // fresh UUID on every transport call, including resumes,
          // which broke the SDK's built-in continuation contract:
          // `Chat.makeRequest` does `replaceLastMessage` only when
          // `state.message.id === this.lastMessage.id` — with a fresh
          // UUID that comparison is always false and the SDK
          // `pushMessage`s a duplicate assistant bubble for the
          // post-approval continuation. (This is what leaves the
          // original `proposePlan` part stuck at "Drafting plan..." —
          // its `output-available` lands on the new bubble instead.)
          //
          // The SDK gates the override on the LAST message's role being
          // "assistant", so fresh turns (last is user) still fall
          // through to the `generateMessageId` callback below for a
          // brand-new id.
          originalMessages: validatedMessages,
          // Mint a stable id for this assistant response. Without this,
          // the SDK's `processUIMessageStream` leaves `state.message.id`
          // at its `""` default (the `start` chunk omits `messageId`
          // when `generateMessageId` isn't supplied), and every
          // `readUIMessageStream` consumer downstream sees id `""`.
          // Under SW-host that meant the persister upserted every
          // assistant chunk to the same `id:""` row in chat-db, and
          // any UI logic that resolves messages by id (STREAM_PARTS
          // snapshot apply, approval-response matching) collapsed
          // multiple turns into one slot. Always generate.
          generateMessageId: () => crypto.randomUUID(),
        });
      } catch (err) {
        // Re-log with the converted ModelMessage[] payload, since
        // standardizePrompt failures inside agent.stream don't include
        // any indication of which message blew up otherwise.
        console.error(
          "[transport] agent.stream failed on fast-path:",
          err instanceof Error ? err.message : String(err),
        );
        console.error(
          "[transport] ModelMessage[] payload at failure:",
          modelMessages,
        );
        throw err;
      }
    }

    // Gate path: open a manually-controlled stream and run the rejection
    // loop in the background. Each iteration's chunks are forwarded to
    // the controller as they arrive; if the gate rejects (within budget)
    // we append synthetic completion-check feedback and run another iteration.
    return runWithRejectionLoop({
      // The SDK's full `Agent` returns a `PromiseLike` from `stream()`
      // (specifically `StreamTextResult`), which is structurally
      // compatible with `RejectionLoopAgent` when we cast.
      agent: this.agent as unknown as RejectionLoopAgent,
      validatedMessages,
      sendMessagesAtCall: messages,
      abortSignal,
      pinnedConversationId,
      buildCompletionCheckInput: buildCompletionCheckInput!,
      onCompletionCheckApproved,
    });
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // Reconnection is not supported for in-process direct agent transport.
    return Promise.resolve(null);
  }
}

/**
 * Wrap `convertToModelMessages` with diagnostic logging. The AI SDK
 * throws "Invalid prompt: The messages do not match the ModelMessage[]
 * schema." with no detail about *which* message or part is malformed,
 * which makes downstream healing/transport bugs near-impossible to
 * diagnose from a user error report alone.
 *
 * On failure we log a compact shape summary (id, role, part type, tool
 * state) for every message that was about to be sent, plus the parsed
 * error, then re-throw the original error so existing UI error handling
 * is unchanged. The full UIMessage payload is logged at debug level so
 * a developer can grab it from the panel devtools without bloating the
 * default console.
 *
 * `label` lets us tell apart the two transport paths (fast path vs.
 * rejection-loop iteration) in the log. Once the shape problem is
 * identified and fixed, this wrapper can be inlined back to a plain
 * `convertToModelMessages` call.
 */
async function convertModelMessagesWithDiag(
  messages: AgentUIMessage[],
  tools: ToolSet,
  label: string,
): Promise<Awaited<ReturnType<typeof convertToModelMessages>>> {
  try {
    return await convertToModelMessages(messages, { tools });
  } catch (err) {
    const shape = messages.map((m, i) => ({
      i,
      id: m.id,
      role: m.role,
      partCount: m.parts.length,
      parts: m.parts.map((p) => {
        const pp = p as { type: string; state?: string; toolName?: string };
        const out: Record<string, unknown> = { type: pp.type };
        if (pp.state) out.state = pp.state;
        if (pp.toolName) out.toolName = pp.toolName;
        return out;
      }),
    }));
    console.error(
      `[convertToModelMessages] failed at ${label}:`,
      err instanceof Error ? err.message : String(err),
    );
    console.error(
      `[convertToModelMessages] message shape (${messages.length} messages):`,
      shape,
    );
    // The error path (`path: [N]`) refers to the *converted* model
    // messages, not the source UIMessages, so a direct lookup may not
    // align — but in practice the converter walks UIMessages 1:1 with
    // an interleaved tool-role row for each tool call/result pair, so
    // the misbehaving UIMessage is usually within a small window of
    // the failing index. Print that window to make root-cause obvious
    // without dumping the entire payload.
    const causedByPath = extractCausedByPath(err);
    if (causedByPath != null) {
      const lo = Math.max(0, causedByPath - 2);
      const hi = Math.min(messages.length, causedByPath + 3);
      console.error(
        `[convertToModelMessages] window around model-message index ${causedByPath} ` +
          `(UIMessage range ~${lo}..${hi - 1}):`,
        messages.slice(lo, hi),
      );
    }
    console.debug(
      `[convertToModelMessages] full UIMessage payload:`,
      messages,
    );
    throw err;
  }
}

/**
 * Extract a numeric `path[0]` from the AI SDK's nested AI_TypeValidationError
 * cause chain. Returns null when no usable index is found.
 */
function extractCausedByPath(err: unknown): number | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const e = cur as { cause?: unknown; issues?: unknown };
    const issues = (e as { issues?: { path?: unknown[] }[] }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0]?.path?.[0];
      if (typeof first === "number") return first;
    }
    cur = e.cause;
  }
  return null;
}

/**
 * Pure function: takes the chat's full UIMessage list and produces the
 * list to send to the model. Exported for testing and so other callers
 * (e.g. eventual `prepareStep` integrations) can share the logic.
 *
 * Operates on `AgentUIMessage` directly — its `DATA_PARTS = AgentDataParts`
 * gives us a real `data-compaction` variant in the parts union, so all the
 * helpers below narrow on `p.type === "data-compaction"` without casts.
 *
 * The optional `tools` argument is threaded into `repairToolPart` so the
 * input-normalizer can rescue no-arg tool calls (Opus emits `input: ""`)
 * by coercing them to `{}` when the tool's schema accepts an empty object.
 * Tests that call `rewriteForLLM` without a ToolSet still work — the
 * normalizer just falls through to its drop path for non-object inputs,
 * which is the pre-fix behavior for tests that didn't depend on the
 * rescue.
 */
export function rewriteForLLM(
  messages: AgentUIMessage[],
  tools?: ToolSet,
): AgentUIMessage[] {
  // Step 1: repair legacy broken compaction events. An earlier version of
  // `runCompaction` had a "prune-only fast path" that wrote a compaction
  // event with an empty summary assistant. Sending that message fails the
  // AI SDK's Zod validation ("Message must contain at least one part").
  // We detect those broken events (compaction-user immediately followed
  // by an assistant with no parts) and excise the whole event — the
  // user-with-CompactionPart, the empty summary, and any adjacent
  // synthetic auto-continue user that followed. Stale-data only; new code
  // never produces this shape.
  const repaired = excludeBrokenCompactionEvents(messages);
  let working = repaired;

  const event = findLatestCompactionEvent(repaired);
  if (event) {
    const tailStartId = event.compactionPart.data.tailStartMessageId;
    const tailIdx = tailStartId
      ? repaired.findIndex((m) => m.id === tailStartId)
      : -1;
    const retainedTailStart =
      tailIdx >= 0 && tailIdx < event.userIndex ? tailIdx : event.userIndex;

    working = [
      // The compaction-user marker — substituted to "What did we do so far?"
      // before sending (see substituteCompactionPart below).
      repaired[event.userIndex],
      // The summary assistant message.
      repaired[event.summaryIndex],
      // Retained tail (messages from tailStartMessageId up to but not
      // including the compaction-user).
      ...repaired.slice(retainedTailStart, event.userIndex),
      // Everything after the summary (auto-continue + subsequent turns).
      ...repaired.slice(event.summaryIndex + 1),
    ];
  }

  const protectedStart = findProtectedTailStart(
    working,
    SCREENSHOT_PROTECTED_TURNS,
  );

  const rewritten = working.map((m, i) => {
    let parts = m.parts;
    parts = substituteCompactionPart(parts);
    parts = substituteMentionContextPart(parts);
    // Plan-extension markers are UI-only — strip before the LLM ever
    // sees them. The empty-parts filter below removes user messages
    // whose only content was a stripped marker.
    parts = stripPlanExtensionParts(parts);
    // Only strip screenshots from messages older than the last
    // SCREENSHOT_PROTECTED_TURNS user turns. Recent screenshots ride
    // along intact so the model retains visual recall across one user-
    // input boundary; older ones become a typed placeholder that the
    // screenshot tool's `toModelOutput` adapter renders as a text
    // marker.
    if (i < protectedStart) {
      parts = stripScreenshotsFromParts(parts);
    }
    parts = prunePartsAtSendTime(parts);
    if (parts === m.parts) return m;
    return { ...m, parts };
  });

  // Final safety net: drop any message that still ended up with empty
  // parts after substitution + pruning. Should be unreachable now that
  // `excludeBrokenCompactionEvents` runs first, but cheap insurance.
  const filtered = rewritten.filter((m) => m.parts.length > 0);

  // Defensive tool-state heal: convertToModelMessages requires every
  // tool part to be in a terminal state with the data it needs to
  // produce a valid model message (`output` for output-available,
  // `errorText` for output-error, etc.). The chat hook's
  // `healPendingTools` runs at edit/retry/regenerate time, but a tool
  // part can also reach the transport in a non-terminal state on a
  // mid-stream abort that happens *between* the chat hook's heal pass
  // and this rewrite — for example, the user editing while a tool's
  // output is still streaming, then immediately resending. Heal here
  // as a last line of defense; the failure mode otherwise is an
  // opaque "Invalid prompt: messages do not match the ModelMessage[]
  // schema" thrown from convertToModelMessages with no detail about
  // which part is malformed.
  // Heal each message, then drop any that became empty. The heal can DROP an
  // input-less interrupted tool part (see `repairToolPart` /
  // `healNonTerminalToolParts`), so a message whose only content was such a
  // part must be removed too — an empty assistant message would otherwise
  // reach `convertToModelMessages`.
  return filtered
    .map((m) => healNonTerminalToolParts(m, tools))
    .filter((m) => m.parts.length > 0);
}

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

const TRANSPORT_HEAL_TEXT =
  "Tool execution was interrupted before it returned a result";

/**
 * Sentinel returned by `repairToolPart` to mean "this tool part cannot be
 * represented as a valid provider message — drop it entirely". See the
 * input-less-interrupted case in `repairToolPart`.
 */
const DROP_TOOL_PART = Symbol("drop-tool-part");

/**
 * Repair a single tool UIPart so that `convertToModelMessages` can map
 * it to a fully-valid `ModelMessage`. The AI SDK's `standardizePrompt`
 * (which runs inside `streamText`) validates the converted messages
 * against a strict Zod schema; a part that's nominally in a "terminal"
 * state but missing required fields (`input` on every tool part,
 * `output` on `output-available`, `errorText` on `output-error`,
 * `approval.approved` on `output-denied`) produces a
 * `ModelMessage[]` that fails validation downstream — with no
 * indication of which message was malformed.
 *
 * The healer enforces these invariants:
 *
 *  1. A tool part must carry a usable `input` THAT IS A JSON OBJECT.
 *     `normalizeToolInput` runs the recovery ladder:
 *       - plain object → keep
 *       - stringified-JSON object (Opus quirk) → parse and use
 *       - rawInput (object or stringified) → use it
 *       - tool's schema accepts `{}` → coerce no-arg call to `{}`
 *       - else → DROP. Substituting `{}` here would re-trigger the
 *         tool's strict required-fields schema in validateUIMessages
 *         and crash the whole turn instead of just dropping one call.
 *     A non-object input (e.g. `""`, `null`, an array, a non-JSON
 *     string) reaches the provider as-is otherwise:
 *       - Anthropic/Bedrock 400 with
 *         `tool_use.input: Input should be a valid dictionary` /
 *         `tool_use.input: Field required`.
 *       - Gemini/Vertex coerces silently (which is why Gemini retries
 *         "just work" on a conversation that 400s on Opus).
 *     A `tool_use` with no recoverable input carries no information for
 *     the model, and each UI tool part expands to a self-contained
 *     `tool-call` + paired `tool-result`, so dropping the whole part
 *     removes both sides cleanly (no orphaned `tool_result`).
 *
 *  2. State is terminal. Any non-terminal state collapses to
 *     `output-error` with `errorText: TRANSPORT_HEAL_TEXT` and the
 *     existing `output` (if any) discarded.
 *
 *  3. The terminal-state-specific required field is present:
 *      - `output-available` requires `output`. If missing, downgrade
 *        to `output-error` so we have a defined errorText carrier.
 *      - `output-error` requires `errorText`. If missing, fill with
 *        the heal text.
 *      - `output-denied` requires `approval` with `approved: false`.
 *        If missing, fall back to `output-error`.
 */
function repairToolPart(
  part: AgentUIMessage["parts"][number],
  tools?: ToolSet,
): AgentUIMessage["parts"][number] | typeof DROP_TOOL_PART {
  const p = part as { type?: unknown; state?: unknown };
  const isTool =
    p.type === "dynamic-tool" ||
    (typeof p.type === "string" && p.type.startsWith("tool-"));
  if (!isTool) return part;

  const raw = part as Record<string, unknown>;
  const state = typeof raw.state === "string" ? raw.state : undefined;
  const partType = typeof raw.type === "string" ? raw.type : "";
  const toolName =
    typeof raw.toolName === "string" ? raw.toolName : undefined;

  // Normalize `input` against the strict provider contract: must be a JSON
  // object. The normalizer applies the recovery ladder (parse stringified
  // JSON, fall back to rawInput, rescue no-arg tools by coercing to `{}`)
  // and signals `drop` for irrecoverable non-object inputs. See
  // `normalizeToolInput` for the full ladder.
  const normalized = normalizeToolInput({
    value: raw.input,
    rawValue: raw.rawInput,
    tools,
    partType,
    toolName,
  });
  // The structural schema rejects a tool part missing the `input` key,
  // so a part that's keeping its existing input still needs the key
  // re-added if it was absent. `inputKeyMissing` covers that case for
  // the few branches where we'd otherwise return the part verbatim.
  const inputKeyMissing = !("input" in raw);

  // `approval-responded` is NOT a terminal state, but it is a
  // legitimate intermediate the SDK resumes from — DON'T heal it away.
  //
  // When the user clicks Allow, the SDK marks the tool part
  // `approval-responded` with `approval.approved === true` and fires the
  // auto-resume. `convertToModelMessages` maps a preserved
  // approval-responded part (with `approval.approved != null`) into a
  // `tool-call` + `tool-approval-request` + `tool-approval-response`
  // triple, and the SDK's `collect-tool-approvals` then re-executes the
  // approved call. If we collapse it to `output-error` here (as the
  // generic non-terminal branch below would), the tool NEVER runs and
  // the user sees "Interrupted" the instant they approve. So:
  //   - approved (approved === true), no output yet → pass through so
  //     the SDK runs `execute`. Drop if the input couldn't be normalized
  //     (the call would 400 the provider on the auto-resume turn).
  //   - explicitly denied (approved === false) → fold to output-denied,
  //     the canonical terminal shape for a denial.
  //   - malformed approval (no id / approved not boolean) → fall through
  //     to the generic heal below (output-error).
  if (state === "approval-responded") {
    const approval = raw.approval as
      | { id?: unknown; approved?: unknown; reason?: unknown }
      | undefined;
    if (approval && typeof approval.id === "string") {
      if (approval.approved === true) {
        // Awaiting execution — preserve verbatim. Without a normalized
        // input the SDK would emit a `tool_use` the provider rejects on
        // auto-resume, so drop irrecoverable parts here too.
        if (normalized.kind === "drop") {
          return DROP_TOOL_PART;
        }
        if (raw.input !== normalized.value) {
          return { ...raw, input: normalized.value } as typeof part;
        }
        return part;
      }
      if (approval.approved === false) {
        if (normalized.kind === "drop") {
          return DROP_TOOL_PART;
        }
        return {
          ...raw,
          input: normalized.value,
          state: "output-denied",
          approval: {
            id: approval.id,
            approved: false,
            ...(typeof approval.reason === "string"
              ? { reason: approval.reason }
              : {}),
          },
          output: undefined,
        } as typeof part;
      }
    }
    // Malformed approval shape → generic heal below.
  }

  // Non-terminal state → collapse to output-error. Drop any partial
  // output so the part is unambiguous.
  if (!state || !TERMINAL_TOOL_STATES.has(state)) {
    // An interrupted call whose input cannot be normalized to an object
    // (no real `input`, no `rawInput`, schema doesn't accept `{}`)
    // cannot be emitted as a valid `tool_use`. Drop it entirely.
    if (normalized.kind === "drop") {
      return DROP_TOOL_PART;
    }
    return {
      ...raw,
      input: normalized.value,
      state: "output-error",
      errorText: TRANSPORT_HEAL_TEXT,
      output: undefined,
    } as typeof part;
  }

  // Terminal state: enforce the per-state required field. Mutate
  // toward output-error if the canonical field is missing — that's
  // safer than letting an unfilled `output-available` reach the
  // converter.
  if (state === "output-available") {
    if (raw.output === undefined || raw.output === null) {
      // Downgrading to output-error; same drop guard as above.
      if (normalized.kind === "drop") {
        return DROP_TOOL_PART;
      }
      return {
        ...raw,
        input: normalized.value,
        state: "output-error",
        errorText: TRANSPORT_HEAL_TEXT,
        output: undefined,
      } as typeof part;
    }
    if (normalized.kind === "drop") {
      // A successful tool call (it has output!) whose input we cannot
      // normalize. This shouldn't happen in practice because the SDK
      // wouldn't have called execute() with a bad input, but if a stale
      // chat-db row has it, drop rather than send a malformed tool_use.
      return DROP_TOOL_PART;
    }
    if (raw.input !== normalized.value || inputKeyMissing) {
      return { ...raw, input: normalized.value } as typeof part;
    }
    return part;
  }

  if (state === "output-error") {
    // A terminal errored call whose input cannot be normalized cannot be
    // emitted as a valid `tool_use`. Drop it. (Pre-fix this was the
    // exact Opus reproduction: a failed MCP call whose input was never
    // captured persisted as output-error with no input → 400 from
    // Anthropic on every subsequent send.)
    if (normalized.kind === "drop") {
      return DROP_TOOL_PART;
    }
    const errorText =
      typeof raw.errorText === "string" && raw.errorText.length > 0
        ? raw.errorText
        : TRANSPORT_HEAL_TEXT;
    if (
      raw.input !== normalized.value ||
      inputKeyMissing ||
      raw.errorText !== errorText
    ) {
      return {
        ...raw,
        input: normalized.value,
        state: "output-error",
        errorText,
      } as typeof part;
    }
    return part;
  }

  if (state === "output-denied") {
    const approval = raw.approval as
      | { id?: unknown; approved?: unknown; reason?: unknown }
      | undefined;
    // Same drop guard as output-error.
    if (normalized.kind === "drop") {
      return DROP_TOOL_PART;
    }
    // Strict denial shape: state=output-denied REQUIRES `approved: false`.
    // `approved: true` paired with that state is contradictory and gets
    // healed to a clean output-error rather than carried forward.
    const hasValidApproval =
      approval &&
      typeof approval.id === "string" &&
      approval.approved === false;
    if (!hasValidApproval) {
      return {
        ...raw,
        input: normalized.value,
        state: "output-error",
        errorText: TRANSPORT_HEAL_TEXT,
        output: undefined,
      } as typeof part;
    }
    if (raw.input !== normalized.value || inputKeyMissing) {
      return { ...raw, input: normalized.value } as typeof part;
    }
    return part;
  }

  // Defensive default — unreachable given TERMINAL_TOOL_STATES above.
  return part;
}

function healNonTerminalToolParts(
  message: AgentUIMessage,
  tools?: ToolSet,
): AgentUIMessage {
  let changed = false;
  const newParts: AgentUIMessage["parts"] = [];
  for (const part of message.parts) {
    const repaired = repairToolPart(part, tools);
    if (repaired === DROP_TOOL_PART) {
      // Input-less interrupted tool call — omit it entirely (see
      // repairToolPart). Its paired tool-result comes from the same part,
      // so nothing is orphaned.
      changed = true;
      continue;
    }
    if (repaired !== part) changed = true;
    newParts.push(repaired);
  }
  if (!changed) return message;
  return { ...message, parts: newParts };
}

/**
 * Removes broken auto-compaction events (compaction-user immediately
 * followed by an assistant with no parts). Also strips the synthetic
 * auto-continue user message that typically follows the broken pair, to
 * avoid leaving the conversation with adjacent user messages that
 * Anthropic rejects.
 *
 * The "Continue where you left off..." text is the canonical auto-continue
 * sentinel; we match by exact prefix to keep the heuristic conservative.
 */
const AUTO_CONTINUE_PREFIX = "Continue where you left off";

function excludeBrokenCompactionEvents(
  messages: AgentUIMessage[],
): AgentUIMessage[] {
  const skipIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const hasCompactionPart = m.parts.some(
      (p) => p.type === "data-compaction",
    );
    if (!hasCompactionPart) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant") continue;
    if (next.parts.length > 0) continue;

    skipIds.add(m.id);
    skipIds.add(next.id);

    const after = messages[i + 2];
    if (after && after.role === "user") {
      const text = after.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text.startsWith(AUTO_CONTINUE_PREFIX)) {
        skipIds.add(after.id);
      }
    }
  }

  if (skipIds.size === 0) return messages;
  return messages.filter((m) => !skipIds.has(m.id));
}

/**
 * Mirrors `findCompactionEvents` but operates on the SDK's UIMessage
 * (which does not carry our `summary: true` flag). We treat the assistant
 * message immediately following a user-with-CompactionPart as the summary.
 * Persistence layer guarantees this pairing exists once a compaction is
 * complete.
 */
function findLatestCompactionEvent(messages: AgentUIMessage[]):
  | {
      userIndex: number;
      summaryIndex: number;
      compactionPart: CompactionPart;
    }
  | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    // `find` narrows `part` to the data-compaction variant of
    // `UIMessagePart<AgentDataParts, ...>`, which is structurally
    // identical to `CompactionPart`.
    const part = m.parts.find((p) => p.type === "data-compaction");
    if (!part) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant") continue;
    return {
      userIndex: i,
      summaryIndex: i + 1,
      compactionPart: part,
    };
  }
  return undefined;
}

/**
 * Replaces any `CompactionPart` on a parts array with a synthetic text
 * part for the model. Returns the same reference when nothing changed.
 */
function substituteCompactionPart(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  let changed = false;
  const out: AgentUIMessage["parts"] = [];
  for (const p of parts) {
    if (p.type === "data-compaction") {
      // TextUIPart is a member of `AgentUIMessage["parts"][number]`, so
      // pushing it widens to the union with no cast.
      out.push({ type: "text", text: COMPACTION_USER_PROMPT });
      changed = true;
    } else {
      out.push(p);
    }
  }
  return changed ? out : parts;
}

/**
 * Replaces any `data-mention-context` part with a synthetic text part so
 * the resolved mention context (mentioned tabs/chats, captured at send
 * time) reaches the model. It is deliberately kept out of the message's
 * own text part (see `MentionContextPart`) so the chat bubble renders
 * clean without any UI-side stripping; this is the single injection
 * point. Returns the same reference when nothing changed.
 */
function substituteMentionContextPart(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  let changed = false;
  const out: AgentUIMessage["parts"] = [];
  for (const p of parts) {
    if (p.type === "data-mention-context") {
      out.push({ type: "text", text: p.data.text });
      changed = true;
    } else {
      out.push(p);
    }
  }
  return changed ? out : parts;
}

/**
 * Strip `data-plan-extension` marker parts from a parts array before
 * sending to the LLM. The model has no use for these — they're a UI
 * signal that the auto-extend hook flipped the plan — and a user
 * message containing only this part would convert to a `user` model
 * message with empty `content`, failing the SDK's prompt validation.
 *
 * The empty-parts filter in `rewriteForLLM` then drops any message
 * whose only content was a stripped marker.
 */
function stripPlanExtensionParts(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  if (!parts.some((p) => p.type === "data-plan-extension")) return parts;
  return parts.filter((p) => p.type !== "data-plan-extension");
}

/**
 * Mutates approval-responded tool parts to a terminal state using the
 * raw tool outputs captured during a stream iteration.
 *
 * Why this exists
 * ---------------
 * When a Plan-mode user clicks "Approve" on a `proposePlan` (or any
 * other approval-gated) tool call, the SDK marks that tool part
 * `approval-responded(approved: true, output: undefined)` and fires
 * the auto-resume. The resume runs *inside* the next `agent.stream`
 * call (round 0 of the rejection loop), and the tool's actual output
 * arrives as `tool-output-available` chunks — but those chunks flow
 * to the controller and don't mutate the rejection loop's local
 * `messages` array. The persisted/UI part stays at
 * `approval-responded` until the chat layer reconciles it.
 *
 * The rejection loop reuses the same `messages` array across rounds.
 * If round 0 was rejected, the loop appends a synthetic feedback user
 * message and starts round 1. The `proposePlan` part is no longer the
 * last message, so the SDK's `collect-tool-approvals` (which only
 * inspects `messages.at(-1)`) won't resume it. `convertToModelMessages`
 * then emits `tool_use` + `tool-approval-request` + `tool-approval-response`
 * with NO `tool-result` block — and Anthropic/Bedrock rejects the
 * payload with `tool_use ids were found without tool_result blocks
 * immediately after`.
 *
 * The fix is to terminalize approved-but-unfinished parts between
 * rounds, using the raw outputs `pipeAndObserve` collected from
 * round 0's `tool-output-available` chunks. Matching is by
 * `toolCallId` so we can preserve the correct output verbatim.
 *
 * Healing rules
 * -------------
 *  - Only `state === "approval-responded" && approval.approved === true
 *    && output === undefined` parts are healed. Approved parts that
 *    already have an `output` (defensive — shouldn't happen since the
 *    SDK assigns it on resume but doesn't update the UI part) are left
 *    alone, as are denied parts (those go through `repairToolPart`'s
 *    output-denied path).
 *  - `rawToolOutputs[id].state === "completed"` → `output-available`
 *    with the raw output preserved.
 *  - `"errored"` → `output-error` with the raw `errorText`.
 *  - `"denied"` → `output-denied` (defensive — denied tools don't
 *    reach approval-responded, but heal anyway).
 *  - Missing entry, or `"pending"` → `output-error` with the generic
 *    `TRANSPORT_HEAL_TEXT`. This is the conservative fallback when we
 *    can't observe what happened (e.g. the chunk stream ended before
 *    a result arrived). The model sees a benign "interrupted" tool
 *    result instead of a dangling `tool_use`.
 *
 * The `approval` field is preserved on the part so the UI can still
 * render the approval pill; the SDK ignores it once `state` is
 * terminal. `input` is preserved unchanged.
 *
 * Returns a NEW `messages` array (immutable style — same as
 * `healPendingTools`), so callers can `messages = terminalize(...)`
 * without worrying about shared references.
 */
export function terminalizeApprovedToolCalls(
  messages: AgentUIMessage[],
  rawToolOutputs: Map<string, RawToolOutput>,
): AgentUIMessage[] {
  let mutated = false;
  const next = messages.map((m) => {
    let partsMutated = false;
    const parts = m.parts.map((p) => {
      const rec = p as Record<string, unknown>;
      const isTool =
        rec.type === "dynamic-tool" ||
        (typeof rec.type === "string" &&
          (rec.type as string).startsWith("tool-"));
      if (!isTool) return p;
      if (rec.state !== "approval-responded") return p;
      const approval = rec.approval as
        | { approved?: unknown }
        | undefined;
      if (!approval || approval.approved !== true) return p;
      if (rec.output !== undefined) return p;
      const toolCallId =
        typeof rec.toolCallId === "string" ? rec.toolCallId : undefined;
      const raw = toolCallId
        ? rawToolOutputs.get(toolCallId)
        : undefined;
      partsMutated = true;
      if (raw?.state === "completed") {
        return {
          ...rec,
          state: "output-available",
          output: raw.output,
        } as typeof p;
      }
      if (raw?.state === "errored") {
        return {
          ...rec,
          state: "output-error",
          errorText: raw.errorText ?? TRANSPORT_HEAL_TEXT,
          output: undefined,
        } as typeof p;
      }
      if (raw?.state === "denied") {
        return {
          ...rec,
          state: "output-denied",
          output: undefined,
        } as typeof p;
      }
      // No raw entry, or still pending → conservative heal.
      return {
        ...rec,
        state: "output-error",
        errorText: TRANSPORT_HEAL_TEXT,
        output: undefined,
      } as typeof p;
    });
    if (!partsMutated) return m;
    mutated = true;
    return { ...m, parts } as AgentUIMessage;
  });
  return mutated ? next : messages;
}

/**
 * Minimal contract the rejection loop needs from an `Agent`. We don't
 * import the SDK's full `Agent` here so this function can be exercised
 * by tests with a tiny stub instead of a real `ToolLoopAgent`.
 */
export interface RejectionLoopAgent {
  /** Tool set passed to `convertToModelMessages` for tool-aware validation. */
  tools: ToolSet;
  stream(args: {
    prompt: Awaited<ReturnType<typeof convertToModelMessages>>;
    abortSignal?: AbortSignal;
  }): Promise<{
    toUIMessageStream(options?: {
      generateMessageId?: () => string;
      /**
       * Passed through to the SDK so its built-in resume continuation
       * (`getResponseUIMessageId` in ai/dist/index.mjs) can reuse the
       * LAST assistant message's id when the input ends in one. Required
       * for the approval-resume path; see the call site in
       * `runWithRejectionLoop`.
       */
      originalMessages?: AgentUIMessage[];
    }): ReadableStream<UIMessageChunk>;
  }>;
}

/**
 * Drives the gate-aware rejection loop. Returns a single output
 * `ReadableStream<UIMessageChunk>` composed of the concatenated
 * chunks from every agent iteration this turn produces, in order.
 *
 * The chat layer (`useAgentChat`) sees this as one assistant message;
 * rejection events are emitted as `data-completion-check-rejection`
 * parts so the UI can render an inline completion-check block per
 * round.
 *
 * Loop termination:
 *  - approved | skipped | force-emitted: close the output stream
 *    and return.
 *  - rejected and within budget: append a synthetic completion-check-feedback
 *    user message to the local copy of the message list, increment
 *    rejection round, restart the loop.
 *  - Loop body throws: error the controller; the chat hook surfaces
 *    the failure as it would for any agent error.
 *
 * Abort behavior: the outer `abortSignal` is threaded into every
 * `agent.stream` call. A user-initiated stop terminates the in-flight
 * iteration; the loop exits the next time it observes the signal.
 *
 * Exported as a free function (rather than a method) so unit tests can
 * exercise the full loop with a stub `RejectionLoopAgent` and a
 * controlled `buildCompletionCheckInput`.
 */
export function runWithRejectionLoop(args: {
  agent: RejectionLoopAgent;
  validatedMessages: AgentUIMessage[];
  sendMessagesAtCall: AgentUIMessage[];
  abortSignal: AbortSignal | undefined;
  pinnedConversationId: string | null;
  buildCompletionCheckInput: (params: {
    sendMessages: AgentUIMessage[];
    finalText: string;
    toolCallTrace: ToolCallTraceEntry[];
    pinnedConversationId: string | null;
  }) =>
    | Promise<RunCompletionCheckInput | undefined>
    | RunCompletionCheckInput
    | undefined;
  onCompletionCheckApproved?: (conversationId: string, now: number) => void | Promise<void>;
}): ReadableStream<UIMessageChunk> {
  const { agent, abortSignal, buildCompletionCheckInput, pinnedConversationId, onCompletionCheckApproved } = args;

  return new ReadableStream<UIMessageChunk>({
    start: async (controller) => {
      // Local-copy semantics: we mutate `messages` (append synthetic
      // user turns) without affecting the chat layer's view, since
      // these synthetic turns are internal to the rejection loop and
      // must not be persisted to chat history.
      let messages: AgentUIMessage[] = args.validatedMessages.slice();
      const sendMessagesAtCall = args.sendMessagesAtCall;

      let rejectionRound = 0;

      try {
        // Bounded loop guard. The gate enforces its own
        // maxRejectionRounds, but a defensive ceiling here protects
        // against a misconfiguration that lets every verdict fall
        // through to "rejected" without the gate noticing budget.
        // 16 is far above any sensible production setting (~3).
        const HARD_CEILING = 16;
        for (let i = 0; i < HARD_CEILING; i++) {
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }

          const modelMessages = await convertModelMessagesWithDiag(
            messages,
            agent.tools,
            `rejection-loop.iter-${i}`,
          );
          assertModelMessageToolInputs(
            modelMessages,
            `rejection-loop.iter-${i}`,
          );
          let result;
          try {
            result = await agent.stream({
              prompt: modelMessages,
              abortSignal,
            });
          } catch (err) {
            console.error(
              `[transport] agent.stream failed on rejection-loop.iter-${i}:`,
              err instanceof Error ? err.message : String(err),
            );
            console.error(
              "[transport] ModelMessage[] payload at failure:",
              modelMessages,
            );
            throw err;
          }

          const observed = await pipeAndObserve(
            result.toUIMessageStream({
              // Pass the current loop's `messages` (which mutates as
              // synthetic user turns are appended per rejection round)
              // so the SDK reuses the LAST assistant message's id when
              // the loop is resuming an approval. See the matching call
              // in the fast path above for the full rationale.
              originalMessages: messages,
              // See the fast-path call site above for why this matters
              // (id:"" → all chunks coalesce into one chat-db row).
              generateMessageId: () => crypto.randomUUID(),
            }),
            controller,
          );

          // A user-initiated Stop terminates the turn. The AI SDK
          // surfaces this two ways, and we check both:
          //   1. `observed.aborted` — the stream carried an
          //      `{ type: "abort" }` chunk. This is the reliable signal:
          //      it's emitted by the stream at the exact moment of abort
          //      and survives regardless of how the abort flag's timing
          //      lines up with the gate window.
          //   2. `abortSignal?.aborted` — defensive fallback for a Stop
          //      that lands between iterations.
          // Either way: close the output and skip the completion check.
          // Running it would grade an abandoned draft (the partial text
          // streamed before Stop) — which is exactly the bug where
          // pressing Stop triggered the quality check.
          if (observed.aborted || abortSignal?.aborted) {
            controller.close();
            return;
          }

          const input = await buildCompletionCheckInput({
            sendMessages: sendMessagesAtCall,
            finalText: observed.finalText,
            toolCallTrace: observed.toolCallTrace,
            pinnedConversationId,
          });

          if (!input) {
            controller.close();
            return;
          }

          // Re-check the abort signal once more before committing to an
          // evaluator call. `buildCompletionCheckInput` is async (it
          // reads todos from chatDb in production), so a user-initiated
          // Stop can land *during* that await — after the post-stream
          // guard above already passed. Without this second check the
          // gate would still fire the evaluator on an abandoned draft,
          // which is exactly the "Stop still runs the completion check"
          // bug.
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }

          // Pre-check the trigger heuristic before announcing a running
          // indicator. Skipped turns (no final text or trivial Q&A
          // with no tool calls) shouldn't flash a "Running quality
          // check…" pill that immediately vanishes.
          const gateDecision = shouldGate({
            finalText: input.draftedResponse,
            todos: input.todos,
            toolCallTrace: input.toolCallTrace,
          });

          let outcome: GateOutcome;
          if (!gateDecision.gate) {
            // The gate would skip; call runCompletionCheck anyway to
            // record telemetry consistently with the non-skipped path.
            // The function is idempotent on its skip decision —
            // shouldGate is deterministic, so the outcome here will
            // always match.
            outcome = await runCompletionCheck({
              ...input,
              rejectionRound,
              // Inject the outer signal so the evaluator is cancellable
              // even though the production `buildCompletionCheckInput`
              // doesn't set it. `input.abortSignal` (if any) wins via
              // the explicit override below only when undefined here.
              abortSignal: input.abortSignal ?? abortSignal,
            });
          } else {
            // Real evaluator call: surface the running indicator for
            // its lifetime so the user knows why the message hasn't
            // closed yet.
            const runningId = crypto.randomUUID();
            emitCompletionCheckRunningChunk(controller, {
              id: runningId,
              phase: "evaluating",
            });
            let resolvedOutcome: GateOutcome | undefined;
            try {
              resolvedOutcome = await runCompletionCheck({
                ...input,
                rejectionRound,
                abortSignal: input.abortSignal ?? abortSignal,
              });
            } finally {
              // Always flip the indicator off — even if
              // `runCompletionCheck` threw — so the UI doesn't show a
              // perpetual spinner. On the throw path, we report
              // "force-emitted" so the UI hides cleanly; the outer
              // try/catch will surface the real error to the
              // controller.
              emitCompletionCheckRunningChunk(controller, {
                id: runningId,
                phase: "done",
                outcome: resolvedOutcome?.kind ?? "force-emitted",
              });
            }
            outcome = resolvedOutcome;
          }

          // A Stop that landed *during* the evaluator call cancels it
          // (the evaluator honors `abortSignal`), which surfaces inside
          // runCompletionCheck as a force-emit fallback. On a
          // user-initiated abort we must not render that fallback as a
          // visible completion-check block — the user cancelled, so
          // close silently instead of emitting rejection/force-emit
          // chunks.
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }

          if (outcome.kind !== "rejected") {
            // Persist the tab-cleanup completion marker (no-op unless approved).
            if (outcome.kind === "approved") {
              try {
                const res = onCompletionCheckApproved?.(
                  input.conversationId,
                  Date.now(),
                );
                if (res instanceof Promise) {
                  res.catch((err) =>
                    console.warn(
                      "[completion-check] persistence callback rejected:",
                      err,
                    ),
                  );
                }
              } catch (err) {
                console.warn(
                  "[completion-check] persistence callback threw:",
                  err,
                );
              }
            }
            // approved | skipped | force-emitted — done.
            // For force-emitted, surface a final rejection-comment so
            // the user can see what concerns the agent ended on.
            if (outcome.kind === "force-emitted") {
              emitCompletionCheckRejectionChunk(controller, {
                rejectionRound: rejectionRound + 1,
                reasoning: outcome.verdict.reasoning,
                concerns: outcome.verdict.concerns.map((c) => ({
                  dimension: c.dimension,
                  detail: c.detail,
                  userSummary: c.userSummary,
                  evidence: c.evidence,
                })),
                forceEmittedNext: true,
                // Threading `outcome.reason` lets the UI distinguish
                // "real concerns the user should see" (max-rounds) from
                // "evaluator itself failed" (evaluator-error). The
                // latter renders as a subtle gray note rather than an
                // alarming red banner because the agent's actual
                // response is unaffected.
                reason: outcome.reason,
              });
            }
            controller.close();
            return;
          }

          // Rejected and within budget. Emit a visible completion-check
          // data part so the chat UI can render the concerns inline,
          // then append synthetic completion-check feedback as a user-role
          // message and loop.
          emitCompletionCheckRejectionChunk(controller, {
            rejectionRound: rejectionRound + 1,
            reasoning: outcome.verdict.reasoning,
            concerns: outcome.verdict.concerns.map((c) => ({
              dimension: c.dimension,
              detail: c.detail,
              userSummary: c.userSummary,
              evidence: c.evidence,
            })),
            forceEmittedNext: false,
          });
          const synthetic = buildCompletionCheckFeedbackMessage(
            outcome.verdict,
            rejectionRound + 1,
          );
          // Heal any approval-responded(approved:true, no output) tool
          // parts to a terminal state using the raw outputs observed in
          // this iteration's stream. Without this step, the next round's
          // `convertToModelMessages` would emit `tool_use` followed by a
          // tool message with NO `tool_result` block — Anthropic/Bedrock
          // rejects that with `tool_use ids were found without
          // tool_result blocks immediately after`.
          //
          // This only matters across rounds (the auto-resume inside the
          // current iteration handled the SDK side), so we run it after
          // observing the iteration but before appending the synthetic
          // feedback that turns the approved part into a non-last
          // message.
          messages = terminalizeApprovedToolCalls(
            messages,
            observed.rawToolOutputs,
          );
          messages = [...messages, synthetic];
          rejectionRound++;
        }

        console.warn(
          "[completion-check] rejection loop hit hard ceiling; closing stream",
        );
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Last-mile defense before `agent.stream(...)`: walks the converted
 * `ModelMessage[]` and asserts every `tool-call` block carries a
 * plain-object `input`. A non-object input would 400 the Anthropic API
 * (`tool_use.input: Input should be a valid dictionary`) — the exact
 * failure mode this whole module is built to prevent. By the time we
 * reach this function, repairToolPart, the persistence sanitizer, and
 * the v16 chat-db migration should all have caught any malformed
 * shape; this is the assertion that proves they did.
 *
 * On detection:
 *   1. Coerces the bad input to `{}` IN PLACE (mutates the
 *      ModelMessage array). Coercion matches the Gemini adapter's
 *      lenient behavior — the user's request still completes — and
 *      avoids a hard failure on what should be unreachable.
 *   2. Logs a `console.error` with the message index, content-block
 *      index, tool name, the offending value's typeof, and a truncated
 *      JSON string. This is the diagnostic that turns "the agent
 *      mysteriously 400'd on Opus once last week" into a one-look
 *      DevTools entry.
 *
 * Why coerce instead of throw: throwing here aborts the user's turn even
 * though the upstream layers should have caught the error. Coercing to
 * `{}` matches what Gemini does silently and what the user expects when
 * an empty-args tool is called. The log makes it easy to find and fix
 * the root cause if this ever fires.
 */
export function assertModelMessageToolInputs(
  modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>,
  label: string,
): void {
  for (let i = 0; i < modelMessages.length; i++) {
    const m = modelMessages[i];
    if (!Array.isArray(m.content)) continue;
    for (let j = 0; j < m.content.length; j++) {
      const c = m.content[j] as { type?: string; input?: unknown; toolName?: string; toolCallId?: string };
      if (c.type !== "tool-call") continue;
      const input = c.input;
      // Anthropic requires tool_use.input to be a PLAIN JSON object —
      // not a Date, Map, Set, RegExp, or class instance. Use the strict
      // plain-object predicate so a non-serializable object can't slip
      // through the assertion (it would JSON.stringify to either an
      // empty `{}` or a non-conforming shape and either silently lose
      // information or trip a downstream validation error).
      if (isPlainObject(input)) continue;

      // Truncate the JSON-stringified value for the log so a giant blob
      // doesn't blow up the DevTools console. Catch in case the value
      // is a circular structure.
      let valueRepr: string;
      try {
        const s = JSON.stringify(input);
        valueRepr = s == null ? String(input) : s.length > 120 ? s.slice(0, 120) + "…" : s;
      } catch {
        valueRepr = "<unstringifiable>";
      }
      console.error(
        `[transport] ${label}: tool-call at modelMessages[${i}].content[${j}] ` +
          `(toolName=${c.toolName ?? "?"}, toolCallId=${c.toolCallId ?? "?"}) ` +
          `has non-object input (typeof=${typeof input}, value=${valueRepr}). ` +
          `Coercing to {}. ` +
          `This is unreachable if compacting-transport's repairToolPart, ` +
          `serialize-parts' sanitizer, and the chat-db v16 migration all ` +
          `ran — please file a bug if you see this in production.`,
      );

      // Coerce in place. The ModelMessage array is locally owned at
      // this call site (we just produced it via convertToModelMessages),
      // so mutating it has no observable side-effect outside this turn.
      (m.content[j] as { input: unknown }).input = {};
    }
  }
}


/**
 * Mutates the observer state for one streaming chunk. Extracted from the
 * transform handler so the chunk-shape switch is testable in isolation
 * (no streams or transports required).
 *
 * Recognized chunk types follow the AI SDK v5 UIMessageChunk shape.
 * Unknown chunk types are ignored — the observer only needs the subset
 * relevant to gate input. Schema drift in the SDK would silently drop
 * gate signal but never break the stream.
 *
 * Tool-call lifecycle:
 *  - `tool-input-available` / `dynamic-tool-input-available` / `tool-call`
 *    creates an entry keyed by `toolCallId`, captures the input, and
 *    sets state to `"pending"`.
 *  - `tool-output-available` / `dynamic-tool-output-available` flips the
 *    matching entry's state to `"completed"` and captures the output
 *    (truncated to {@link TRACE_OUTPUT_TRUNCATE_CHARS}).
 *  - `tool-output-error` / `dynamic-tool-output-error` flips to
 *    `"errored"` and captures the error text in `outputSummary`.
 *  - `tool-output-denied` flips to `"denied"`; `outputSummary` stays null.
 *  - Tool calls without a matching `toolCallId` (orphans) are ignored
 *    on the output side — the input chunk's entry stays `"pending"` and
 *    surfaces that to the evaluator. Unknown `toolCallId`s in output
 *    chunks (output before input — shouldn't happen, but defensively
 *    handled) are dropped.
 */
/**
 * Raw (untruncated) tool-output capture, parallel to the truncated
 * `ToolCallTraceEntry` map. Used by the rejection-loop driver to
 * terminalize approval-responded tool parts between rounds (so the
 * model sees a real `tool-result` block instead of a stranded
 * `tool_use`). The trace's `outputSummary` is hard-truncated for the
 * evaluator's prompt budget; that's too lossy to feed back to the
 * primary model as a tool result. Hence this parallel raw map.
 */
export interface RawToolOutput {
  state: "completed" | "errored" | "denied" | "pending";
  /** Raw, untruncated tool output. Set when `state === "completed"`. */
  output?: unknown;
  /** Raw error text. Set when `state === "errored"`. */
  errorText?: string;
}

export function observeChunkForCompletionCheck(
  chunk: UIMessageChunk,
  state: {
    textBuffers: Map<string, string>;
    setLastTextMessageId: (id: string) => void;
    toolCalls: Map<string, ToolCallTraceEntry>;
    /**
     * Insertion-order list of toolCallIds. Used to materialize the
     * final trace array in chunk-arrival order regardless of `Map`
     * iteration semantics (well-defined in modern JS, but we keep an
     * explicit list to make the contract obvious to readers).
     */
    toolCallOrder: string[];
    /**
     * Parallel raw-output capture, keyed by `toolCallId`. Optional so
     * existing callers (tests, completion-check observers) that only
     * need the truncated trace don't have to allocate it. Populated in
     * lockstep with `toolCalls` when present.
     */
    rawToolOutputs?: Map<string, RawToolOutput>;
  },
): void {
  // The SDK's UIMessageChunk is a discriminated union. Narrow defensively;
  // we only care about a few variants.
  const c = chunk as { type: string; [k: string]: unknown };
  switch (c.type) {
    case "text-start": {
      const id = typeof c.id === "string" ? c.id : undefined;
      if (id) {
        state.setLastTextMessageId(id);
        if (!state.textBuffers.has(id)) state.textBuffers.set(id, "");
      }
      break;
    }
    case "text-delta": {
      const id = typeof c.id === "string" ? c.id : undefined;
      const delta = typeof c.delta === "string" ? c.delta : "";
      if (id) {
        state.setLastTextMessageId(id);
        state.textBuffers.set(id, (state.textBuffers.get(id) ?? "") + delta);
      }
      break;
    }
    case "tool-input-available":
    case "dynamic-tool-input-available":
    case "tool-call": {
      const name =
        typeof c.toolName === "string"
          ? c.toolName
          : typeof c.name === "string"
            ? c.name
            : "(unknown-tool)";
      const inputSummary = stringifyTruncate(
        c.input ?? c.args ?? c.parameters ?? c.toolInput,
        TRACE_INPUT_TRUNCATE_CHARS,
      );

      // Use toolCallId when available (real SDK chunks always have it).
      // Fall back to a synthetic key for legacy `tool-call` shapes used
      // in some tests so they still produce a unique entry per chunk.
      const toolCallId =
        typeof c.toolCallId === "string" && c.toolCallId.length > 0
          ? c.toolCallId
          : `__synthetic-${state.toolCallOrder.length}`;

      // Defensive: a duplicate input chunk for the same call shouldn't
      // happen but if it did we'd want to keep the first observation.
      if (!state.toolCalls.has(toolCallId)) {
        state.toolCalls.set(toolCallId, {
          name,
          inputSummary,
          outputSummary: null,
          state: "pending",
        });
        state.toolCallOrder.push(toolCallId);
        state.rawToolOutputs?.set(toolCallId, { state: "pending" });
      }
      break;
    }
    case "tool-output-available":
    case "dynamic-tool-output-available": {
      const toolCallId =
        typeof c.toolCallId === "string" ? c.toolCallId : undefined;
      if (!toolCallId) break;
      // Always update rawToolOutputs first — independent of whether
      // toolCalls saw a preceding `tool-input-available` chunk for
      // this id. The SDK's auto-resume path (re-executing an
      // approved-but-unfinished tool call) DOES NOT re-emit the input
      // chunk; only the output chunk arrives. Without this lazy
      // creation, terminalizeApprovedToolCalls would find no entry in
      // rawToolOutputs and fall back to the generic interruption
      // heal, dropping the real result.
      if (state.rawToolOutputs) {
        const raw = state.rawToolOutputs.get(toolCallId);
        if (raw) {
          raw.state = "completed";
          raw.output = c.output;
        } else {
          state.rawToolOutputs.set(toolCallId, {
            state: "completed",
            output: c.output,
          });
        }
      }
      // The truncated `toolCalls` trace still requires a preceding
      // input chunk — without it we'd fabricate a `name` /
      // `inputSummary`-less entry the evaluator can't read. Skip
      // updating it in that case (the trace is best-effort signal for
      // the gate, not authoritative).
      const entry = state.toolCalls.get(toolCallId);
      if (!entry) break;
      entry.outputSummary = stringifyTruncate(
        c.output,
        TRACE_OUTPUT_TRUNCATE_CHARS,
      );
      entry.state = "completed";
      break;
    }
    case "tool-output-error":
    case "dynamic-tool-output-error": {
      const toolCallId =
        typeof c.toolCallId === "string" ? c.toolCallId : undefined;
      if (!toolCallId) break;
      const errorText =
        typeof c.errorText === "string" && c.errorText.length > 0
          ? c.errorText
          : "(tool error)";
      // Lazy-create the rawToolOutputs entry so the auto-resume path
      // (no preceding input chunk) still records the error. See the
      // comment in the output-available branch above.
      if (state.rawToolOutputs) {
        const raw = state.rawToolOutputs.get(toolCallId);
        if (raw) {
          raw.state = "errored";
          raw.errorText = errorText;
        } else {
          state.rawToolOutputs.set(toolCallId, {
            state: "errored",
            errorText,
          });
        }
      }
      const entry = state.toolCalls.get(toolCallId);
      if (!entry) break;
      entry.outputSummary =
        errorText.length > TRACE_OUTPUT_TRUNCATE_CHARS
          ? errorText.slice(0, TRACE_OUTPUT_TRUNCATE_CHARS) + "… (truncated)"
          : errorText;
      entry.state = "errored";
      break;
    }
    case "tool-output-denied": {
      const toolCallId =
        typeof c.toolCallId === "string" ? c.toolCallId : undefined;
      if (!toolCallId) break;
      // Lazy-create. See comment in the output-available branch above.
      if (state.rawToolOutputs) {
        const raw = state.rawToolOutputs.get(toolCallId);
        if (raw) {
          raw.state = "denied";
        } else {
          state.rawToolOutputs.set(toolCallId, { state: "denied" });
        }
      }
      const entry = state.toolCalls.get(toolCallId);
      if (!entry) break;
      entry.outputSummary = null;
      entry.state = "denied";
      break;
    }
    default:
      // Other chunk types (errors, finish, reasoning, etc.) don't
      // contribute to gate input. Intentional no-op.
      break;
  }
}

/**
 * Stringify and truncate a value for inclusion in the tool-call trace.
 * Strings pass through; everything else is JSON.stringified. Returns
 * the empty string for `undefined`/serialization failures so the
 * resulting `inputSummary`/`outputSummary` is always a string.
 *
 * Truncation appends `"… (truncated)"` so the evaluator can detect when
 * content was cut and avoid drawing conclusions from the tail.
 */
function stringifyTruncate(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) return "";
  let str: string;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "(not serializable)";
  }
  if (str === undefined) return "";
  return str.length > maxChars
    ? str.slice(0, maxChars) + "… (truncated)"
    : str;
}

/**
 * Reads every chunk from `input`, forwards it to `controller`, and
 * accumulates gate-relevant signal (final text + tool-call trace) via
 * {@link observeChunkForCompletionCheck}. Returns the accumulated signal
 * once the input stream closes.
 *
 * Used inside the rejection-loop driver: each agent iteration's chunks
 * stream through to the user-visible output, then we have the full
 * final text + trace to hand to the gate. Errors during observation
 * are logged and never break the user-visible stream.
 *
 * `aborted` reports whether the stream carried an `{ type: "abort" }`
 * chunk. On a user-initiated Stop the AI SDK aborts the signal and its
 * `toUIMessageStream()` emits this chunk then closes the stream
 * *cleanly* (no throw) — so a populated `finalText` here does NOT mean
 * the turn finished. The rejection-loop driver uses `aborted` to skip
 * the completion check on an abandoned draft, independent of the
 * `abortSignal.aborted` flag (whose timing relative to the gate window
 * is unreliable). The abort chunk is still forwarded to the controller
 * so the UI can render the aborted state.
 */
export async function pipeAndObserve(
  input: ReadableStream<UIMessageChunk>,
  controller: ReadableStreamDefaultController<UIMessageChunk>,
): Promise<{
  finalText: string;
  toolCallTrace: ToolCallTraceEntry[];
  /**
   * Raw (untruncated) tool outputs keyed by `toolCallId`. Built in
   * lockstep with `toolCallTrace`. Consumed by the rejection-loop
   * driver to terminalize approval-responded tool parts between
   * rounds. Existing callers can ignore this field.
   */
  rawToolOutputs: Map<string, RawToolOutput>;
  aborted: boolean;
}> {
  const textBuffers = new Map<string, string>();
  let lastTextMessageId: string | undefined;
  const toolCalls = new Map<string, ToolCallTraceEntry>();
  const toolCallOrder: string[] = [];
  const rawToolOutputs = new Map<string, RawToolOutput>();
  let aborted = false;

  const reader = input.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      controller.enqueue(value);
      if ((value as { type?: string }).type === "abort") {
        aborted = true;
      }
      try {
        observeChunkForCompletionCheck(value, {
          textBuffers,
          setLastTextMessageId: (id) => {
            lastTextMessageId = id;
          },
          toolCalls,
          toolCallOrder,
          rawToolOutputs,
        });
      } catch (err) {
        console.warn("[completion-check] observer error:", err);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const finalText =
    (lastTextMessageId && textBuffers.get(lastTextMessageId)) ?? "";
  // Materialize in chunk-arrival order. Entries without a matching
  // toolCallId in the order list (defensive — shouldn't happen) are
  // dropped to keep the trace deterministic.
  const toolCallTrace = toolCallOrder
    .map((id) => toolCalls.get(id))
    .filter((e): e is ToolCallTraceEntry => e !== undefined);
  return { finalText, toolCallTrace, rawToolOutputs, aborted };
}

/**
 * Constants the executor sees when completion-check feedback is injected. Kept
 * as exported constants so the system prompt and the synthetic-message
 * builder share one definition — drift between "what the prompt
 * promises" and "what the loop emits" is the most likely source of
 * subtle behavioral bugs here.
 */
export const COMPLETION_CHECK_PREFIX = "[Completion check]";

/**
 * Format an `EvaluatorVerdict` (decision="reject") into a user-role
 * `AgentUIMessage` that gets appended to the agent's context for the
 * next rejection-loop iteration.
 *
 * The format is intentionally machine-shaped: a fixed prefix, then a
 * bullet per concern with `dimension: detail`. The system prompt tells
 * the executor to expect this shape and to treat it as a continuation
 * directive (not a fresh user request). Having a stable prefix also
 * makes the synthetic messages identifiable in chat-history dumps if a
 * future debug tool wants to filter them out.
 *
 * The synthetic message is given a fresh uuid so the AI SDK's
 * deduplication-by-id logic doesn't collapse it with anything.
 */
export function buildCompletionCheckFeedbackMessage(
  verdict: EvaluatorVerdict,
  rejectionRound: number,
): AgentUIMessage {
  const concernLines = verdict.concerns
    .map((c) => {
      const ev = c.evidence ? `\n   Evidence: ${c.evidence}` : "";
      return `- ${c.dimension}: ${c.detail}${ev}`;
    })
    .join("\n");

  const text =
    `${COMPLETION_CHECK_PREFIX} (round ${rejectionRound})\n` +
    `${verdict.reasoning}\n\n` +
    `Concerns to address before this turn is complete:\n${concernLines}\n\n` +
    `Continue working until each concern is resolved. Do not produce a final response that leaves any of these unaddressed.`;

  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

/**
 * Emit a `data-completion-check-rejection` chunk into the live UI stream.
 *
 * The Vercel AI SDK accumulates `data-${string}` chunks into a
 * matching part on the active assistant message — so this single
 * chunk produces a `{ type: "data-completion-check-rejection", id, data }`
 * entry in `message.parts`, which the UI can detect and render as a
 * completion-check block. The same part is then persisted to chat-db
 * by the chat hook's `onFinish` because it serializes the full parts
 * array, so the comment survives reloads.
 *
 * `transient: false` (the default) keeps the part attached to the
 * message in the UI's message list. We use `false` deliberately —
 * users should be able to scroll back and see why the agent kept
 * working past its first draft.
 *
 * The `id` is deterministic per chunk (uuid) so two consecutive
 * rejection rounds produce two distinct parts rather than the SDK
 * collapsing them by id.
 */
export function emitCompletionCheckRejectionChunk(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  data: {
    rejectionRound: number;
    reasoning: string;
    concerns: {
      dimension: ConcernDimension;
      detail: string;
      userSummary: string;
      evidence?: string;
    }[];
    forceEmittedNext?: boolean;
    reason?: "max-rounds-exceeded" | "evaluator-error";
  },
): void {
  // Cast through `never` because the AI SDK types its data-part chunks
  // as `data-${string}` with `data: unknown` — TS can't statically
  // associate our specific `completion-check-rejection` key with the
  // `CompletionCheckRejectionData` shape from `AgentDataParts`. The
  // shape *is* registered there; the cast is a TS limitation, not a
  // runtime risk.
  controller.enqueue({
    type: "data-completion-check-rejection",
    id: crypto.randomUUID(),
    data,
  } as never);
}

/**
 * Emit a `data-completion-check-running` chunk to surface the live
 * status of an in-flight evaluator call.
 *
 * Lifecycle (one stable `id` per gate invocation):
 *  1. Just before `runCompletionCheck` runs, call this with
 *     `phase: "evaluating"` and a fresh uuid. The UI shows an inline
 *     "Running quality check…" pill.
 *  2. After the verdict resolves, call again with the SAME `id` and
 *     `phase: "done"` plus the resolved `outcome` kind. The AI SDK
 *     mutates the existing part's data in place (same `id` + same
 *     type → overwrite, see `process-ui-message-stream.ts:817-831`),
 *     so no second part is appended.
 *
 * The "evaluating" → "done" transition surviving a reload (because
 * the part persists with whatever `phase` it ended on) is the reason
 * the UI also gates render on `isStreaming`: aborted streams that
 * leave the part stuck at "evaluating" should not render a fake live
 * spinner forever.
 *
 * Skipped turns (trigger heuristic returned `gate: false`) are
 * pre-checked in the rejection loop and never emit running chunks at
 * all — see the `shouldGate` call in `runWithRejectionLoop`.
 */
export function emitCompletionCheckRunningChunk(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  data: {
    id: string;
    phase: "evaluating" | "done";
    outcome?: "approved" | "skipped" | "rejected" | "force-emitted";
  },
): void {
  // The chunk's `id` field MUST match the data's `id` so the SDK's
  // overwrite-by-id semantics work for the evaluating → done update.
  controller.enqueue({
    type: "data-completion-check-running",
    id: data.id,
    data,
  } as never);
}
