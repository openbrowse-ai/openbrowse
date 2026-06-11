import { useEffect, useState } from "react";
import { chatDb } from "../../../lib/chat-db";
import { useConversationId } from "../../../lib/conversation-id-context";
import {
  SUBAGENT_CHILD_ASSIGNED_EVENT,
  type SubagentChildAssignedDetail,
} from "../../../lib/agent/tools/delegate";
import {
  SUBAGENT_TITLE_UPDATED_EVENT,
  type SubagentTitleUpdatedDetail,
} from "../../../lib/agent/tools/set-task-title";
import { getAgent } from "../../../lib/agent/subagents/registry";
import type {
  SerializedAssistantMessage,
  SubagentRunResult,
} from "../../../lib/agent/subagents/types";
import { SubagentTrace } from "./subagent-trace";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
  toolCallId: string;
  /**
   * The underlying part state. `errored` means the parent stream was
   * interrupted before the subagent persisted a result; the call has
   * been healed via `healPendingTools` to `output-error`.
   */
  state?: "call" | "result" | "denied" | "errored";
  /** Heal-time error text shown when `state === "errored"`. */
  errorText?: string;
}

/**
 * Renders the result of a `delegate` tool call as an AI Elements
 * `Task` block. The block is the entire UI for the call — there is no
 * outer `ToolCallBlock` wrapper around it (see ToolCallBlock.tsx for
 * the bypass) and no navigation to a child view (the trace itself
 * shows everything the subagent did).
 *
 * Live update sources, in priority order:
 *   1. `SUBAGENT_TITLE_UPDATED_EVENT` — fires from setTaskTitle calls
 *      keyed to this delegation's toolCallId.
 *   2. chat-db `subagentTraceTitle` field (peer/incognito, survives
 *      reload).
 *   3. The delegation `task` arg (truncated).
 *
 * Trace transcript:
 *   - `result.transcript` (final snapshot baked into the tool result)
 *   - chat-db live subscription (peer/incognito, updates while the
 *     run is in flight).
 */
export function DelegateResult({ args, result, toolCallId, state, errorText }: Props) {
  const slug = typeof args.slug === "string" ? args.slug : "subagent";
  const task = typeof args.task === "string" ? args.task : "";

  const r = (result ?? {}) as Partial<SubagentRunResult>;
  const status = r.status;
  const resultError = r.errorMessage;
  const finalChildId = r.childConversationId ?? null;
  const resultTranscript = r.transcript ?? [];

  // Was this call healed because the parent stream ended before the
  // subagent persisted a result? If so, we treat it as terminal-failed
  // regardless of `result`/`status` (which are absent for healed calls).
  const wasInterrupted = state === "errored";

  // Live child id (assigned mid-run for peer/incognito). Used to drive
  // the chat-db live subscription below; we no longer expose any
  // navigation to the child view.
  const [liveChildId, setLiveChildId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SubagentChildAssignedDetail>).detail;
      if (detail?.toolCallId === toolCallId && detail.childConversationId) {
        setLiveChildId(detail.childConversationId);
      }
    };
    window.addEventListener(SUBAGENT_CHILD_ASSIGNED_EVENT, handler);
    return () => {
      window.removeEventListener(SUBAGENT_CHILD_ASSIGNED_EVENT, handler);
    };
  }, [toolCallId]);

  // Recovered child id (reload path). When the parent turn was aborted
  // mid-run, `healPendingTools` strips the delegate call's `output` —
  // taking `childConversationId` with it (heal-pending-tools.ts) — and
  // the heal is persisted. After a chat switch + return the reloaded
  // part has no `output`, so `finalChildId` is null and the
  // SUBAGENT_CHILD_ASSIGNED_EVENT (a live-only DOM event) never re-fires,
  // leaving `liveChildId` null too. The trace would then collapse to just
  // the interrupt error even though the child conversation's messages are
  // still persisted in chat-db.
  //
  // Recover the link via the child row's `parentToolCallId` stamp
  // (runner.ts), keyed by the parent conversation id from context. This
  // is self-healing: it restores traces for conversations that were
  // already broken before this fix shipped. Only runs when we have no
  // child id from the other two sources, and tolerates `undefined`
  // (older child rows created before `parentToolCallId` existed).
  const parentConversationId = useConversationId();
  const [recoveredChildId, setRecoveredChildId] = useState<string | null>(
    null,
  );
  const needsRecovery = finalChildId === null && liveChildId === null;
  useEffect(() => {
    if (!needsRecovery || !parentConversationId || !toolCallId) {
      setRecoveredChildId(null);
      return;
    }
    let cancelled = false;
    void chatDb
      .findChildByParentToolCallId(parentConversationId, toolCallId)
      .then((child) => {
        if (cancelled) return;
        setRecoveredChildId(child?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setRecoveredChildId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [needsRecovery, parentConversationId, toolCallId]);

  const childId = finalChildId ?? liveChildId ?? recoveredChildId;

  // Live transcript (peer/incognito only). Reads chat-db when the
  // child conversation's messages change.
  const liveTranscript = useChildLiveTranscript(childId);

  // Live trace title from setTaskTitle. Updated via DOM event AND from
  // chat-db (so a reload mid-run still shows the most recent title).
  const liveTitle = useTraceTitle(toolCallId, childId);

  // Resolved model the subagent ran on. Prefers the child conversation's
  // live `usage.modelId` (the model that actually ran, including user
  // overrides like `cuaModel`), falling back to the agent definition's
  // configured `defaultModel`.
  const model = useChildModel(childId, slug);

  const transcript: SerializedAssistantMessage[] =
    liveTranscript ?? resultTranscript;

  // Resolution order for the trigger title.
  const triggerTitle =
    liveTitle ?? (task.length > 0 ? truncate(task, 80) : `${slug.charAt(0).toUpperCase() + slug.slice(1)} Agent`);

  // While the parent's tool call is still pending in the SDK, `result`
  // is undefined → the subagent is still running. Healed-to-output-error
  // calls also have `result === undefined`, but `state === "errored"`
  // disambiguates them as terminal-failed.
  const isRunning = result === undefined && !wasInterrupted;
  const isFailed =
    wasInterrupted ||
    status === "failed" ||
    status === "cancelled" ||
    status === "budget-exceeded";

  // Pick the error message: heal text takes precedence when interrupted
  // (the runner never wrote a SubagentRunResult), otherwise use the
  // result's errorMessage.
  const error = wasInterrupted
    ? (errorText ??
      "Tool execution was interrupted before it returned a result")
    : resultError;

  return (
    <SubagentTrace
      transcript={transcript}
      slug={slug}
      triggerTitle={triggerTitle}
      isRunning={isRunning}
      isFailed={isFailed}
      error={error}
      task={task}
      model={model}
    />
  );
}

/**
 * Subscribes to chat-db updates for `childConversationId` and returns
 * the current assistant transcript. Returns `null` when no childId is
 * provided (e.g. inline runs) so the caller can fall back to the
 * static `result.transcript`.
 */
function useChildLiveTranscript(
  childConversationId: string | null,
): SerializedAssistantMessage[] | null {
  const [transcript, setTranscript] = useState<
    SerializedAssistantMessage[] | null
  >(null);

  useEffect(() => {
    if (!childConversationId) {
      setTranscript(null);
      return;
    }

    let cancelled = false;
    async function refresh() {
      const messages = await chatDb.getMessages(childConversationId!);
      if (cancelled) return;
      setTranscript(
        messages
          .filter((m) => m.role === "assistant")
          .map((m) => ({ id: m.id, parts: m.parts })),
      );
    }
    void refresh();

    const unsubscribe = chatDb.subscribeMessageChange((convId) => {
      if (convId === childConversationId) void refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [childConversationId]);

  return transcript;
}

/**
 * Resolve the model the subagent ran on.
 *
 * Priority:
 *   1. The child conversation's live `usage.modelId` (peer/incognito) —
 *      the model that actually executed, reflecting user overrides like
 *      `cuaModel`. Updated live via chat-db subscription.
 *   2. The agent definition's configured `defaultModel`.
 *   3. `null` — the subagent inherited the parent's model (e.g. the
 *      `explore`/`general` agents whose `defaultModel` is undefined).
 */
function useChildModel(
  childConversationId: string | null,
  slug: string,
): string | null {
  const [liveModelId, setLiveModelId] = useState<string | null>(null);

  useEffect(() => {
    if (!childConversationId) {
      setLiveModelId(null);
      return;
    }
    let cancelled = false;
    async function refresh() {
      const conv = await chatDb.getConversation(childConversationId!);
      if (cancelled) return;
      setLiveModelId(conv?.usage?.modelId ?? null);
    }
    void refresh();
    const unsubscribe = chatDb.subscribeConversationChange((convId) => {
      if (convId === childConversationId) void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [childConversationId]);

  const configuredModel = getAgent(slug)?.defaultModel ?? null;
  return liveModelId ?? configuredModel;
}

/**
 * Resolve the trace title from the two live sources:
 *   1. `SUBAGENT_TITLE_UPDATED_EVENT` matching `toolCallId` (fires every
 *      time the subagent calls setTaskTitle).
 *   2. chat-db `subagentTraceTitle` on the child conv (peer/incognito;
 *      survives reload).
 *
 * Returns null when no title has been set anywhere; the caller falls
 * back to the delegation `task` arg.
 */
function useTraceTitle(
  toolCallId: string,
  childConversationId: string | null,
): string | null {
  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [persistedTitle, setPersistedTitle] = useState<string | null>(null);

  // DOM event channel.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SubagentTitleUpdatedDetail>).detail;
      if (detail?.toolCallId === toolCallId && detail.title) {
        setEventTitle(detail.title);
      }
    };
    window.addEventListener(SUBAGENT_TITLE_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(SUBAGENT_TITLE_UPDATED_EVENT, handler);
    };
  }, [toolCallId]);

  // chat-db channel (only when we have a child conv to read from).
  useEffect(() => {
    if (!childConversationId) {
      setPersistedTitle(null);
      return;
    }
    let cancelled = false;
    async function refresh() {
      const conv = await chatDb.getConversation(childConversationId!);
      if (cancelled) return;
      setPersistedTitle(conv?.subagentTraceTitle ?? null);
    }
    void refresh();
    const unsubscribe = chatDb.subscribeConversationChange((convId) => {
      if (convId === childConversationId) void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [childConversationId]);

  // Prefer the most recent live event over the persisted value.
  return eventTitle ?? persistedTitle;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
