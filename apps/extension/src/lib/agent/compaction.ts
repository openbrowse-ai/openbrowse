// src/lib/agent/compaction.ts
import type { ProviderDefinition } from "../../registry/providers/types";
import type {
  AgentUIMessage,
  CompactionPart,
  SerializedUIPart,
} from "../types";
export interface TokenLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

// Constants
export const COMPACTION_BUFFER = 20_000;
export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
export const TOOL_OUTPUT_MAX_CHARS = 2_000;
export const PROTECTED_TURNS = 2;
/**
 * How many recent user turns keep their `screenshot` tool outputs intact
 * when the compacting transport ships the conversation to the model.
 *
 * Held separately from `PROTECTED_TURNS` (which governs the head-pruner's
 * cumulative-output budget) because the two policies are conceptually
 * independent — one tunes summarization input, the other tunes per-turn
 * visual recall — and shouldn't drift together accidentally.
 */
export const SCREENSHOT_PROTECTED_TURNS = 2;
export const TAIL_TURNS = 2;
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;
export const MAX_PRESERVE_RECENT_TOKENS = 8_000;
export const MIN_MESSAGES_FOR_COMPACTION = 4;
/**
 * Time-based debounce for thrash detection. If the latest completed
 * compaction in the conversation finished less than this many milliseconds
 * ago, skip running another compaction. This prevents the
 * compaction-summarizes-but-summary-still-overflows infinite loop without
 * keeping a hidden attempts counter.
 *
 * 30s is a sane default — covers a runaway summary cycle but doesn't block
 * a genuinely long agent run that crosses the threshold a second time.
 */
export const COMPACTION_DEBOUNCE_MS = 30_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_000;
const FALLBACK_USABLE_TOKENS =
  DEFAULT_CONTEXT_WINDOW - DEFAULT_MAX_OUTPUT - COMPACTION_BUFFER;

const COMPACTION_SYSTEM_PROMPT = `You are a context summarization assistant for a browser agent session.

Summarize only the conversation history you are given. The newest turns are kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, update it: preserve still-true details, remove stale details, merge in new facts.

Follow the exact output structure requested. Use terse bullets. Preserve exact URLs, element selectors, error messages, and data values. Do not mention the summary process. Respond in the same language as the conversation.`;

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown below. Keep every section, even when empty.

## Goal
- [what the user is trying to accomplish]

## Plan
- [current todo list state and progress, if any plan was created]

## Pages & Context
- [url]: [what was learned/done there]

## Progress
- [completed actions or "(none)"]

## Key Findings
- [important facts, data, answers]

## Next Steps
- [what to do next or "(none)"]

Rules:
- Use terse bullets, not prose paragraphs.
- Preserve exact URLs, CSS selectors, element text, error strings, and data values.
- Do not mention compaction or summarization.`;

// Token Estimation Functions

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(parts: SerializedUIPart[]): number {
  let total = 0;

  for (const part of parts) {
    if (part.type === "text") {
      total += estimateTokens(part.text);
    } else if (part.type === "reasoning") {
      total += estimateTokens(part.text);
    } else if (part.type === "dynamic-tool") {
      // Estimate input size
      if (part.input !== undefined) {
        total += estimateTokens(JSON.stringify(part.input));
      }
      // Estimate output size
      if (part.output !== undefined) {
        total += estimateTokens(
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output),
        );
      }
    } else if (part.type === "file") {
      total += estimateTokens(part.url);
    } else if (part.type === "data-mention-context") {
      total += estimateTokens(part.data.text);
    } else {
      // Default for other types
      total += 10;
    }
  }

  return total;
}

function resolveTokenLimits(model: TokenLimits | undefined): {
  context: number;
  maxOutput: number;
} {
  // Usage snapshots store 0 when the SW cannot resolve model metadata; treat
  // non-positive values as missing.
  return {
    context:
      model?.contextWindow && model.contextWindow > 0
        ? model.contextWindow
        : DEFAULT_CONTEXT_WINDOW,
    maxOutput:
      model?.maxOutputTokens && model.maxOutputTokens > 0
        ? model.maxOutputTokens
        : DEFAULT_MAX_OUTPUT,
  };
}

/**
 * Whether a model has any room to compact into — i.e. its context window
 * exceeds its output budget plus the safety buffer.
 *
 * False for models that legitimately declare a tiny window (Gemini Nano at 4K,
 * the smallest WebLLM builds): there is no headroom to summarize into, so
 * proactive compaction is meaningless for them. Kept separate from
 * {@link getUsableTokens} because callers need this as a capability signal,
 * whereas `getUsableTokens` must always return a usable positive threshold.
 */
export function hasCompactableContext(model: TokenLimits | undefined): boolean {
  const { context, maxOutput } = resolveTokenLimits(model);
  return maxOutput + COMPACTION_BUFFER < context;
}

export function getUsableTokens(model: TokenLimits | undefined): number {
  const { context, maxOutput } = resolveTokenLimits(model);
  // A non-positive ceiling would make `shouldCompact` true for every turn and
  // loop compaction forever, so fall back to the default. Proactive
  // compaction is effectively off for such models; a genuine context overflow
  // is still recovered by the overflow-triggered compaction path.
  if (maxOutput + COMPACTION_BUFFER >= context) return FALLBACK_USABLE_TOKENS;
  return context - maxOutput - COMPACTION_BUFFER;
}

export function shouldCompact(
  totalTokens: number,
  model: TokenLimits | undefined,
): boolean {
  return totalTokens >= getUsableTokens(model);
}

// Pruning (Phase 1)

export interface PrunableMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: SerializedUIPart[];
  createdAt: number;
}

/**
 * Per-message-part pruner used by the compacting transport at send time.
 *
 * Differs from `pruneMessages`:
 * - Operates on a single message's `parts` (no protected-tail logic — the
 *   transport already preserves the verbatim tail above this layer).
 * - Always trims oversized tool outputs (no `PRUNE_PROTECT` cumulative budget
 *   — that gates the *decision* to compact in `runCompaction`, not what we
 *   send to the model).
 * - Idempotent — running it twice produces identical output.
 *
 * Returns the same array reference when nothing changed (cheap fast-path for
 * messages with no large outputs).
 *
 * Operates on the SDK's `UIMessagePart` union directly via
 * `AgentUIMessage["parts"]` so callers (the transport) don't have to
 * convert to/from our `SerializedUIPart` shape. Only `dynamic-tool` parts
 * are inspected; everything else passes through unchanged.
 *
 * Screenshot-specific elision is *not* handled here — that policy needs
 * cross-message context (which user turns to protect) and lives in the
 * compacting transport via {@link stripScreenshotsFromParts} +
 * {@link findProtectedTailStart}.
 */
export function prunePartsAtSendTime(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  let changed = false;
  const out: AgentUIMessage["parts"] = [];

  for (const part of parts) {
    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      out.push(part);
      continue;
    }

    // Skip image-bearing tools — their large `imageDataUrl` is intentional
    // and gets stripped wholesale (not truncated mid-base64) by
    // `stripScreenshotsFromParts` for older messages. Truncating here would
    // produce a corrupt base64 string that the model can't decode.
    if (part.toolName && STRIPPABLE_IMAGE_TOOLS.has(part.toolName)) {
      out.push(part);
      continue;
    }

    const outputStr =
      typeof part.output === "string"
        ? part.output
        : JSON.stringify(part.output);

    if (outputStr.length > TOOL_OUTPUT_MAX_CHARS) {
      out.push({
        ...part,
        output: outputStr.substring(0, TOOL_OUTPUT_MAX_CHARS) + "...",
      });
      changed = true;
      continue;
    }

    out.push(part);
  }

  return changed ? out : parts;
}

export const STRIPPABLE_IMAGE_TOOLS = new Set(["screenshot"]);

/**
 * Tools whose output is, by construction, a screenshot of the current page
 * state. Used as the DEFAULT allowlist by {@link keepOnlyLatestScreenshot} to
 * safely identify which tool-result parts may have their image stripped.
 *
 * The extension itself only produces `screenshot`. Headless harnesses (the
 * bench) may produce page-state images under other tool names (e.g.
 * `viewPage`) and pass their own allowlist into `keepOnlyLatestScreenshot` —
 * the public extension never hardcodes experiment tool names.
 *
 * IMPORTANT: any allowlist MUST only contain tools that capture page state.
 * It MUST NOT include user-attached images or any other image-bearing
 * channel. The detection is tool-name-based (not output-shape-based)
 * precisely to avoid accidentally stripping images that came from somewhere
 * other than the agent's own perception calls.
 */
export const PAGE_SCREENSHOT_TOOLS = new Set(["screenshot"]);

/**
 * Replaces the output of every completed `screenshot` tool call in
 * `parts` with the typed placeholder shape (`{ removed: "..." }`) that
 * the screenshot tool's `toModelOutput` adapter recognizes.
 *
 * Cross-message recency policy (which messages get their screenshots
 * stripped vs. preserved) lives in the compacting transport — this
 * helper is shape-only and idempotent.
 */
export function stripScreenshotsFromParts(
  parts: AgentUIMessage["parts"],
): AgentUIMessage["parts"] {
  let changed = false;
  const out: AgentUIMessage["parts"] = [];
  for (const part of parts) {
    if (
      part.type === "dynamic-tool" &&
      part.state === "output-available" &&
      part.toolName &&
      STRIPPABLE_IMAGE_TOOLS.has(part.toolName)
    ) {
      out.push({
        ...part,
        output: { removed: "[screenshot removed during compaction]" },
      });
      changed = true;
      continue;
    }
    out.push(part);
  }
  return changed ? out : parts;
}

/**
 * Strict "only-latest screenshot" pruner.
 *
 * Walks every part of every message back-to-front and finds the *latest*
 * page-screenshot tool result (where `toolName ∈ PAGE_SCREENSHOT_TOOLS`).
 * That part is left intact. Every *earlier* page-screenshot tool result has
 * its `output` replaced with the placeholder shape.
 *
 * This is far more aggressive than {@link stripScreenshotsFromParts} +
 * {@link findProtectedTailStart}, which keep N user-turns of screenshots
 * intact. Bench trials have only one user turn (the task instruction), so
 * the user-turn-based policy effectively never strips anything in bench —
 * leading to context bloat from accumulated screenshots. This function fixes
 * that by ensuring at most ONE page screenshot is alive in context at any
 * time.
 *
 * Safety: only inspects parts where `part.type === "dynamic-tool"` AND
 * `part.toolName ∈ PAGE_SCREENSHOT_TOOLS`. User-attached images, file parts,
 * text parts, reasoning parts, and tool calls from any other tool are
 * untouched. This is intentional: we never want to strip a user-uploaded
 * image. Tool-name-based detection is the safest predicate — it would not
 * match even if some unrelated tool happened to return an `imageDataUrl`
 * field in its output.
 *
 * Returns a new messages array if anything changed; the original array
 * (referentially) otherwise.
 */
export function keepOnlyLatestScreenshot(
  messages: AgentUIMessage[],
  allowlist: Set<string> = PAGE_SCREENSHOT_TOOLS,
): AgentUIMessage[] {
  // First pass: find indices of (messageIdx, partIdx) for every page-screenshot
  // tool result with an `imageDataUrl` (non-stripped) output.
  const screenshotLocs: Array<{ m: number; p: number }> = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m];
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p] as any;
      if (
        part?.type === "dynamic-tool" &&
        part.state === "output-available" &&
        typeof part.toolName === "string" &&
        allowlist.has(part.toolName) &&
        part.output &&
        typeof part.output === "object" &&
        "imageDataUrl" in part.output
      ) {
        screenshotLocs.push({ m, p });
      }
    }
  }

  // Nothing to strip: 0 or 1 screenshots present.
  if (screenshotLocs.length <= 1) return messages;

  // Mark all but the last for stripping.
  const stripSet = new Set(
    screenshotLocs.slice(0, -1).map((loc) => `${loc.m}:${loc.p}`),
  );

  return messages.map((msg, m) => {
    let touched = false;
    const newParts = msg.parts.map((part, p) => {
      if (!stripSet.has(`${m}:${p}`)) return part;
      touched = true;
      return {
        ...(part as any),
        output: { removed: "[older screenshot stripped]" },
      };
    });
    return touched ? { ...msg, parts: newParts } : msg;
  });
}

/**
 * Tools whose output embeds a page accessibility snapshot keyed to
 * per-snapshot `@ref` ids. Once a NEWER snapshot of the same tab exists,
 * every earlier snapshot's text is dead weight: its refs are invalid by
 * construction (refs are reassigned on every capture), and the agent is
 * instructed to re-snapshot rather than re-read an old tree. So we keep
 * only the latest snapshot per tab alive in the model's context.
 *
 * Maps the tool name → the output field that carries the snapshot text:
 *   - `snapshot`     → `snapshot`
 *   - `navigate`     → `snapshot` (fresh tree attached on navigation)
 *   - `clickElement` → `snapshot` (auto-attached viewport snapshot post-action)
 *   - `typeInElement`→ `snapshot` (auto-attached viewport snapshot post-action)
 *   - `pressKey`     → `snapshot` (auto-attached viewport snapshot post-action)
 *
 * The grouping key is the tool output's `tab` field, so a multi-tab task
 * keeps the latest snapshot of EACH tab.
 */
export const SNAPSHOT_OUTPUT_FIELDS: Record<string, "snapshot"> = {
  snapshot: "snapshot",
  navigate: "snapshot",
  clickElement: "snapshot",
  typeInElement: "snapshot",
  pressKey: "snapshot",
};

/**
 * Keeps only the latest snapshot-bearing tool output per tab; replaces the
 * snapshot text on every earlier one with a compact stub that preserves
 * orientation metadata (tab, url, refCount) but drops the multi-kilobyte
 * accessibility tree.
 *
 * Why per-tab-latest is safe: `@ref` ids are reassigned on every capture and
 * the ref store only resolves the most recent snapshot, so an older
 * snapshot's refs are already unusable. The agent is told to re-snapshot to
 * refresh refs. We never strip the latest snapshot of any tab, so the model
 * always has a current, actionable view of every tab it touched.
 *
 * Detection is tool-name-based (via SNAPSHOT_OUTPUT_FIELDS) — it never
 * inspects arbitrary outputs, so it cannot accidentally strip non-snapshot
 * data.
 *
 * Idempotent: stubs are recognized (they lack the snapshot field) and skipped
 * on a second pass. Returns the original array reference when nothing changed.
 */
export function keepOnlyLatestSnapshotPerTab(
  messages: AgentUIMessage[],
): AgentUIMessage[] {
  // First pass: locate every live (non-stubbed) snapshot-bearing output,
  // grouped by tab. A part is "live" when its snapshot field is a
  // non-empty string (stubs replace it with an object).
  const locsByTab = new Map<string, Array<{ m: number; p: number }>>();
  for (let m = 0; m < messages.length; m++) {
    const parts = messages[m].parts;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p] as any;
      if (
        part?.type !== "dynamic-tool" ||
        part.state !== "output-available" ||
        typeof part.toolName !== "string"
      ) {
        continue;
      }
      const field = SNAPSHOT_OUTPUT_FIELDS[part.toolName];
      if (!field) continue;
      const output = part.output;
      if (!output || typeof output !== "object") continue;
      // Only count it if the snapshot text is actually present (live).
      if (typeof (output as any)[field] !== "string") continue;
      if (((output as any)[field] as string).length === 0) continue;
      const tab =
        typeof (output as any).tab === "string"
          ? ((output as any).tab as string)
          : "__no_tab__";
      const arr = locsByTab.get(tab) ?? [];
      arr.push({ m, p });
      locsByTab.set(tab, arr);
    }
  }

  // Build the strip set: every snapshot EXCEPT the last one for its tab.
  const stripSet = new Set<string>();
  for (const locs of locsByTab.values()) {
    for (const loc of locs.slice(0, -1)) stripSet.add(`${loc.m}:${loc.p}`);
  }

  if (stripSet.size === 0) return messages;

  return messages.map((msg, m) => {
    let touched = false;
    const newParts = msg.parts.map((part, p) => {
      if (!stripSet.has(`${m}:${p}`)) return part;
      touched = true;
      const anyPart = part as any;
      const field = SNAPSHOT_OUTPUT_FIELDS[anyPart.toolName as string];
      const prev = (anyPart.output ?? {}) as Record<string, unknown>;
      const stub: Record<string, unknown> = {
        superseded: true,
        note: "[older snapshot superseded — call snapshot to refresh refs]",
      };
      if (typeof prev.tab === "string") stub.tab = prev.tab;
      if (typeof prev.url === "string") stub.url = prev.url;
      if (typeof prev.refCount === "number") stub.refCount = prev.refCount;
      // Drop the heavy snapshot text; keep everything else small.
      const { [field]: _omit, ...rest } = prev;
      return { ...anyPart, output: { ...rest, ...stub } };
    });
    return touched ? { ...msg, parts: newParts } : msg;
  });
}

/**
 * Walks `messages` from the end, counting user-role messages, and
 * returns the index of the first message that belongs to the
 * "protected tail" of the most recent `keepUserTurns` user turns. Any
 * message at index `< return value` is in the head and may have its
 * screenshots elided; index `>= return value` is in the tail and
 * should keep its screenshots intact.
 *
 * Mirrors the loop already used inside `pruneMessages` so both pruners
 * share the same notion of "recent user turns."
 */
export function findProtectedTailStart<T extends { role: string }>(
  messages: T[],
  keepUserTurns: number,
): number {
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    userTurnsSeen++;
    if (userTurnsSeen > keepUserTurns) {
      return i + 1;
    }
  }
  // Conversation has fewer than `keepUserTurns` user turns total — every
  // message is in the protected tail.
  return 0;
}

export function pruneMessages(messages: PrunableMessage[]): {
  pruned: PrunableMessage[];
  freedTokens: number;
} {
  // Return unchanged if fewer than minimum messages
  if (messages.length < MIN_MESSAGES_FOR_COMPACTION) {
    return { pruned: messages, freedTokens: 0 };
  }

  // Find protected tail (last PROTECTED_TURNS user turns and everything after)
  let userTurnsSeen = 0;
  let tailStartIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen > PROTECTED_TURNS) {
        tailStartIndex = i + 1;
        break;
      }
    }
  }

  let freedTokens = 0;
  let cumulativeToolOutputTokens = 0;
  const pruned: PrunableMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Don't prune protected tail
    if (i >= tailStartIndex) {
      pruned.push(message);
      continue;
    }

    // Process message parts
    const newParts: SerializedUIPart[] = [];
    let messageChanged = false;

    for (const part of message.parts) {
      if (
        part.type === "dynamic-tool" &&
        part.state === "output-available" &&
        part.output !== undefined
      ) {
        const outputStr =
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output);
        const outputTokens = estimateTokens(outputStr);

        cumulativeToolOutputTokens += outputTokens;

        // Protect the first PRUNE_PROTECT tokens worth
        if (cumulativeToolOutputTokens <= PRUNE_PROTECT) {
          newParts.push(part);
          continue;
        }

        // Beyond threshold, start pruning
        // Check if this is an image-bearing tool (screenshot, viewPage, etc.)
        if (part.toolName && STRIPPABLE_IMAGE_TOOLS.has(part.toolName)) {
          // Replace output with placeholder
          newParts.push({
            ...part,
            output: "[screenshot removed during compaction]",
          });
          freedTokens +=
            outputTokens -
            estimateTokens("[screenshot removed during compaction]");
          messageChanged = true;
        } else if (outputStr.length > TOOL_OUTPUT_MAX_CHARS) {
          // Truncate long outputs
          const truncated =
            outputStr.substring(0, TOOL_OUTPUT_MAX_CHARS) + "...";
          newParts.push({
            ...part,
            output: truncated,
          });
          freedTokens += outputTokens - estimateTokens(truncated);
          messageChanged = true;
        } else {
          newParts.push(part);
        }
      } else {
        newParts.push(part);
      }
    }

    pruned.push(messageChanged ? { ...message, parts: newParts } : message);
  }

  // Only return pruned messages if we freed enough tokens
  if (freedTokens > PRUNE_MINIMUM) {
    return { pruned, freedTokens };
  }

  return { pruned: messages, freedTokens: 0 };
}

// Tail Selection

export function selectTail(
  messages: PrunableMessage[],
  model: TokenLimits | undefined,
): { headMessages: PrunableMessage[]; tailStartId: string | undefined } {
  const usable = getUsableTokens(model);
  const budget = Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable * 0.25)),
  );

  let tokenAccumulator = 0;
  let userTurnsSeen = 0;
  let tailStartIndex = messages.length;

  // Walk backwards through messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const messageTokens = estimateMessageTokens(message.parts);

    // Check if adding this message would exceed budget
    if (tokenAccumulator + messageTokens > budget && userTurnsSeen > 0) {
      tailStartIndex = i + 1;
      break;
    }

    tokenAccumulator += messageTokens;

    // Count user turns
    if (message.role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= TAIL_TURNS) {
        tailStartIndex = i;
        break;
      }
    }
  }

  const headMessages = messages.slice(0, tailStartIndex);
  const tailStartId =
    tailStartIndex < messages.length ? messages[tailStartIndex].id : undefined;

  return { headMessages, tailStartId };
}

/**
 * Tail selection for the user-typed `/compact` command.
 *
 * Auto-compaction (`selectTail`) deliberately preserves the last
 * `TAIL_TURNS` (2) user turns and up to `MAX_PRESERVE_RECENT_TOKENS` of
 * recent context verbatim, only summarizing what spills past that budget —
 * it fires mid-task, so the agent needs recent context to continue.
 *
 * A user typing `/compact` is instead saying "continue from the summary
 * only". So this variant summarizes the ENTIRE conversation and keeps NO
 * verbatim tail: `headMessages` is every message and `tailStartId` is
 * `undefined`. With no tail anchor, `filterCompactedMessages` /
 * `rewriteForLLM` fall back to dropping everything before the compaction
 * marker, so the model sees only the marker + summary (plus any turns that
 * come *after* the compaction). The UI still shows every original message;
 * only the model view is replaced.
 *
 * Returns an empty head when the conversation has fewer than two user
 * turns — there's nothing worth summarizing — so the caller can surface a
 * "conversation too short to compact" message instead of producing a
 * trivial summary.
 */
export function selectTailForManual(messages: PrunableMessage[]): {
  headMessages: PrunableMessage[];
  tailStartId: string | undefined;
} {
  const userTurns = messages.reduce(
    (n, m) => (m.role === "user" ? n + 1 : n),
    0,
  );

  // Need at least two user turns for a meaningful manual compaction.
  if (userTurns < 2) {
    return { headMessages: [], tailStartId: undefined };
  }

  // Summary-only: the whole conversation is the head, no verbatim tail.
  return { headMessages: messages, tailStartId: undefined };
}

export interface ResolvedModelSelection {
  provider: ProviderDefinition;
  /** Bare model id (ModelDefinition.id), suitable for createLanguageModel. */
  modelId: string;
}

/**
 * Resolve a stored model key against the provider registry.
 *
 * Model keys are persisted as composite "providerId:modelId" strings (the
 * format `ModelPicker` writes for both `agentModel` and `compactionModel`),
 * but the registry's model lists and `createLanguageModel` key off the
 * BARE model id. This splits the composite key and resolves the provider,
 * mirroring the canonical agentModel resolution in `useAgentChat`:
 *   - when a provider prefix is present, select the provider by id;
 *   - otherwise (or as a fallback), find the provider whose model list
 *     contains the bare id.
 *
 * Returns `undefined` when no provider matches. The returned `modelId` is
 * always the bare id, ready to hand to `provider.createLanguageModel`.
 */
export function resolveCompactionModel(
  rawModelKey: string,
  providers: ProviderDefinition[],
): ResolvedModelSelection | undefined {
  const [providerId, ...modelIdParts] = rawModelKey.split(":");
  const hasPrefix = modelIdParts.length > 0;
  const modelId = hasPrefix ? modelIdParts.join(":") : rawModelKey;

  const provider =
    (hasPrefix ? providers.find((p) => p.id === providerId) : undefined) ??
    providers.find((p) => p.models.some((m) => m.id === modelId));

  if (!provider) return undefined;
  return { provider, modelId };
}

// Summarization Prompt Builders

export function buildCompactionPrompt(previousSummary?: string): string {
  if (previousSummary) {
    return `<previous-summary>
${previousSummary}
</previous-summary>

Update the anchored summary above by preserving still-true details, removing stale details, and merging in new facts from the conversation history below.

${SUMMARY_TEMPLATE}`;
  }

  return SUMMARY_TEMPLATE;
}

export function getCompactionSystemPrompt(): string {
  return COMPACTION_SYSTEM_PROMPT;
}

// Message Preparation for Summarization

export function prepareMessagesForSummarization(
  messages: PrunableMessage[],
): string {
  const formatted: string[] = [];

  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    const contentParts: string[] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        contentParts.push(part.text);
      } else if (part.type === "reasoning") {
        contentParts.push(`[thinking] ${part.text}`);
      } else if (part.type === "file") {
        contentParts.push("[attached file]");
      } else if (part.type === "dynamic-tool") {
        let toolStr = `[tool: ${part.toolName}]`;

        if (part.input !== undefined) {
          const inputStr = JSON.stringify(part.input);
          const truncatedInput =
            inputStr.length > 500
              ? inputStr.substring(0, 500) + "..."
              : inputStr;
          toolStr += `\ninput: ${truncatedInput}`;
        }

        if (part.output !== undefined) {
          const outputStr =
            typeof part.output === "string"
              ? part.output
              : JSON.stringify(part.output);
          const truncatedOutput =
            outputStr.length > TOOL_OUTPUT_MAX_CHARS
              ? outputStr.substring(0, TOOL_OUTPUT_MAX_CHARS) + "..."
              : outputStr;
          toolStr += `\noutput: ${truncatedOutput}`;
        }

        contentParts.push(toolStr);
      }
    }

    formatted.push(`${role}: ${contentParts.join("\n")}`);
  }

  return formatted.join("\n\n");
}

// Compaction-event helpers (message-based architecture)

/**
 * A "completed compaction" is a user message containing a `CompactionPart`
 * immediately followed by its assistant summary. Persisted messages carry
 * `summary: true`; AI SDK UI messages omit that database-only field, so an
 * absent flag is accepted while an explicit `summary: false` is rejected.
 *
 * The pair represents one auto- or manually-triggered compaction event.
 * The pre-compaction head can be safely dropped from the LLM view; the
 * UI keeps the full history.
 */
export interface CompactionEvent {
  /** Index of the user message carrying the CompactionPart. */
  userIndex: number;
  /** Stable id of the user message, when available. */
  userMessageId?: string;
  /** Index of the assistant message carrying the summary text. */
  summaryIndex: number;
  /** Stable id of the summary assistant message, when available. */
  summaryMessageId?: string;
  /** The CompactionPart on the user message (carries `tailStartMessageId`). */
  part: CompactionPart;
  /** Plain-text summary extracted from the assistant message. */
  summaryText: string;
  /** Timestamp the assistant summary was created at (ms). */
  completedAt: number;
}

/**
 * Walks `messages` in order and identifies completed compaction events.
 *
 * A compaction is "completed" when the user-with-CompactionPart is
 * immediately followed by an assistant summary. The persisted shape marks
 * that assistant with `summary: true`; the in-memory SDK shape has no summary
 * field, so only an explicit `false` rejects the pair. Returns events in
 * chronological order.
 */
export function findCompactionEvents(
  messages: {
    id?: string;
    role: string;
    parts: any[];
    summary?: boolean;
    createdAt?: number;
  }[],
): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const part = m.parts.find(
      (p): p is CompactionPart => p.type === "data-compaction",
    );
    if (!part) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant" || next.summary === false) continue;
    const summaryText = next.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    events.push({
      userIndex: i,
      userMessageId: m.id,
      summaryIndex: i + 1,
      summaryMessageId: next.id,
      part,
      summaryText,
      completedAt: next.createdAt ?? 0,
    });
  }
  return events;
}

/**
 * Time-based debounce: returns true if a recent compaction event finished
 * within `COMPACTION_DEBOUNCE_MS`, indicating we shouldn't run another one
 * yet. Replaces the legacy `attempts` counter.
 */
export function shouldDebounceCompaction(
  events: CompactionEvent[],
  nowMs: number = Date.now(),
): boolean {
  const last = events.at(-1);
  if (!last) return false;
  return nowMs - last.completedAt < COMPACTION_DEBOUNCE_MS;
}

/**
 * Whether a newly selected compaction head contains anything beyond the
 * latest compaction marker and its summary. Re-summarizing only that pair
 * cannot reduce context and is a no-progress loop, regardless of elapsed
 * wall-clock time.
 */
export function hasCompactionHeadProgress(
  headMessages: { id: string }[],
  latestEvent: CompactionEvent | undefined,
): boolean {
  if (!latestEvent?.userMessageId || !latestEvent.summaryMessageId) return true;
  return headMessages.some(
    (message) =>
      message.id !== latestEvent.userMessageId &&
      message.id !== latestEvent.summaryMessageId,
  );
}

/**
 * Reorders messages for the LLM view. For the latest completed compaction,
 * the pre-event head is dropped; the compaction-user message is kept (its
 * CompactionPart will be replaced with synthetic prompt text by the
 * transport before sending), followed by the summary assistant, the
 * retained tail (anchored at `tailStartMessageId` if present, else the
 * messages immediately after the event), and any post-event messages.
 *
 * Returns the original array (unchanged) if there are no completed
 * compactions.
 */
export function filterCompactedMessages<
  T extends { id: string; role: string; parts: any[] },
>(messages: T[]): T[] {
  const events = findCompactionEvents(messages);
  const last = events.at(-1);
  if (!last) return messages;

  const tailStartId = last.part.data.tailStartMessageId;
  const tailIdx = tailStartId
    ? messages.findIndex((m) => m.id === tailStartId)
    : -1;

  // Tail boundary either points back to a message in the pre-compaction
  // head (the normal case — we drop everything before it but keep that
  // message), or it's missing/stale (defensive: fall back to dropping
  // everything before the compaction event itself).
  const retainedTailStart =
    tailIdx >= 0 && tailIdx < last.userIndex ? tailIdx : last.userIndex;

  return [
    // 1. The compaction-user marker (the transport substitutes its
    //    CompactionPart with a "What did we do so far?" text part for the
    //    model view).
    messages[last.userIndex],
    // 2. The summary assistant message.
    messages[last.summaryIndex],
    // 3. The retained tail — messages from the tail boundary up to (but
    //    not including) the compaction-user message.
    ...messages.slice(retainedTailStart, last.userIndex),
    // 4. Everything after the summary message (auto-continue + subsequent
    //    turns).
    ...messages.slice(last.summaryIndex + 1),
  ];
}

/**
 * Compose the prompt content the model sees in place of a CompactionPart.
 * Keeping this as a single source of truth avoids drift between the
 * transport (which substitutes at send time) and any future consumer.
 */
export const COMPACTION_USER_PROMPT = "What did we do so far?";
