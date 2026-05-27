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
  prunePartsAtSendTime,
  stripScreenshotsFromParts,
} from "./compaction";
import {
  runCompletionCheck,
  shouldGate,
  type RunCompletionCheckInput,
} from "./completion-check";
import type {
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
  private readonly getActiveConversationId?: () => string | null;
  private readonly buildCompletionCheckInput?: Options<TOOLS>["buildCompletionCheckInput"];

  constructor({
    agent,
    onSendStart,
    getActiveConversationId,
    buildCompletionCheckInput,
  }: Options<TOOLS>) {
    this.agent = agent;
    this.onSendStart = onSendStart;
    this.getActiveConversationId = getActiveConversationId;
    this.buildCompletionCheckInput = buildCompletionCheckInput;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<AgentUIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    this.onSendStart?.();
    // Pin cid synchronously, before any await. Every chatDb read driven
    // by the gate inside this loop targets this cid even if
    // `setAgentContext(...)` is called by the UI mid-stream.
    const pinnedConversationId = this.getActiveConversationId?.() ?? null;
    const rewritten = rewriteForLLM(messages);

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
      try {
        const result = await this.agent.stream({
          prompt: modelMessages,
          abortSignal,
        });
        return result.toUIMessageStream();
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
      // assignable to `Promise<{ toUIMessageStream() }>` at runtime but
      // TS is strict about `PromiseLike` vs `Promise`. The
      // `RejectionLoopAgent` interface deliberately uses `Promise` to
      // keep the test stub simple; cast through the structural shape.
      agent: this.agent as unknown as RejectionLoopAgent,
      validatedMessages: validatedMessages as AgentUIMessage[],
      sendMessagesAtCall: messages,
      abortSignal,
      pinnedConversationId,
      buildCompletionCheckInput: this.buildCompletionCheckInput,
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
 */
export function rewriteForLLM(messages: AgentUIMessage[]): AgentUIMessage[] {
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
  return filtered.map(healNonTerminalToolParts);
}

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

const TRANSPORT_HEAL_TEXT =
  "Tool execution was interrupted before it returned a result";

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
 * The healer enforces three invariants:
 *
 *  1. `input` is always present. Tool calls aborted before the model
 *     finished streaming arguments may have `input: undefined`. Default
 *     to `{}` so the resulting `tool-call` content has a well-formed
 *     `input` object.
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
): AgentUIMessage["parts"][number] {
  const p = part as { type?: unknown; state?: unknown };
  const isTool =
    p.type === "dynamic-tool" ||
    (typeof p.type === "string" && p.type.startsWith("tool-"));
  if (!isTool) return part;

  const raw = part as Record<string, unknown>;
  const state = typeof raw.state === "string" ? raw.state : undefined;

  // Ensure `input` is always defined for any tool part. Even
  // `output-error` parts go through convertToModelMessages's
  // tool-call/tool-result pair generation, and the assistant tool-call
  // entry it produces requires `input`.
  let input: unknown = raw.input;
  if (input === undefined || input === null) {
    input = {};
  }

  // Non-terminal state → collapse to output-error. Drop any partial
  // output so the part is unambiguous.
  if (!state || !TERMINAL_TOOL_STATES.has(state)) {
    return {
      ...raw,
      input,
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
      return {
        ...raw,
        input,
        state: "output-error",
        errorText: TRANSPORT_HEAL_TEXT,
        output: undefined,
      } as typeof part;
    }
    if (raw.input === undefined || raw.input === null) {
      return { ...raw, input } as typeof part;
    }
    return part;
  }

  if (state === "output-error") {
    const errorText =
      typeof raw.errorText === "string" && raw.errorText.length > 0
        ? raw.errorText
        : TRANSPORT_HEAL_TEXT;
    if (raw.input !== input || raw.errorText !== errorText) {
      return {
        ...raw,
        input,
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
    const hasValidApproval =
      approval &&
      typeof approval.id === "string" &&
      typeof approval.approved === "boolean";
    if (!hasValidApproval) {
      return {
        ...raw,
        input,
        state: "output-error",
        errorText: TRANSPORT_HEAL_TEXT,
        output: undefined,
      } as typeof part;
    }
    if (raw.input !== input) {
      return { ...raw, input } as typeof part;
    }
    return part;
  }

  // Defensive default — unreachable given TERMINAL_TOOL_STATES above.
  return part;
}

function healNonTerminalToolParts(message: AgentUIMessage): AgentUIMessage {
  let changed = false;
  const newParts = message.parts.map((part) => {
    const repaired = repairToolPart(part);
    if (repaired !== part) changed = true;
    return repaired;
  });
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
    toUIMessageStream(): ReadableStream<UIMessageChunk>;
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
}): ReadableStream<UIMessageChunk> {
  const { agent, abortSignal, buildCompletionCheckInput, pinnedConversationId } = args;

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
            result.toUIMessageStream(),
            controller,
          );

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

          if (outcome.kind !== "rejected") {
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
      }
      break;
    }
    case "tool-output-available":
    case "dynamic-tool-output-available": {
      const toolCallId =
        typeof c.toolCallId === "string" ? c.toolCallId : undefined;
      if (!toolCallId) break;
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
      const entry = state.toolCalls.get(toolCallId);
      if (!entry) break;
      const errorText =
        typeof c.errorText === "string" && c.errorText.length > 0
          ? c.errorText
          : "(tool error)";
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
 */
export async function pipeAndObserve(
  input: ReadableStream<UIMessageChunk>,
  controller: ReadableStreamDefaultController<UIMessageChunk>,
): Promise<{
  finalText: string;
  toolCallTrace: ToolCallTraceEntry[];
}> {
  const textBuffers = new Map<string, string>();
  let lastTextMessageId: string | undefined;
  const toolCalls = new Map<string, ToolCallTraceEntry>();
  const toolCallOrder: string[] = [];

  const reader = input.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      controller.enqueue(value);
      try {
        observeChunkForCompletionCheck(value, {
          textBuffers,
          setLastTextMessageId: (id) => {
            lastTextMessageId = id;
          },
          toolCalls,
          toolCallOrder,
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
  return { finalText, toolCallTrace };
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
      dimension: string;
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
