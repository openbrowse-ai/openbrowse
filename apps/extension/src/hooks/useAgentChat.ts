import { chatDb } from "@/lib/chat-db";
import { formatAttachments } from "@/lib/chat/format-attachments";
import { queueDb, subscribeQueueChange } from "@/lib/queue-db";
import {
  resetAgentIndicator,
  setAgentColor,
  setAgentContext,
  needsCompaction,
  resetTokenTracking,
  getCurrentModelDef,
} from "@/lib/agent/agent-transport";
import { setTargetTabId } from "@/lib/agent/active-tab";
import { healPendingTools } from "@/lib/agent/heal-pending-tools";
import { bindSharedTab } from "@/lib/agent/bind-shared-tab";
import { normalizeToolInputForPersistence } from "@/lib/agent/tool-input-normalize";
import { setAgentActive, setAgentInactive } from "@/lib/active-agents";
import {
  abortAgentRun,
  probeAgentRun,
  probeAgentRunAwaitIdle,
  RemoteChatTransport,
} from "@/lib/agent/remote-transport";
import {
  markPendingFirstTurn,
  hasPendingFirstTurn,
  clearPendingFirstTurn,
} from "@/lib/agent/pending-first-turn";
import {
  isStreamPartsMessage,
  isStreamDoneMessage,
  applyStreamSnapshot,
  mergeChatDbWithLocal,
  shouldRecoverFromStuckStreaming,
  SeqGuard,
} from "@/lib/agent/stream-mirror";
import {
  RUNTIME_MESSAGES,
} from "@/lib/constants";
import {
  pruneMessages as pruneMessageParts,
  selectTail,
  selectTailForManual,
  resolveCompactionModel,
  buildCompactionPrompt,
  getCompactionSystemPrompt,
  prepareMessagesForSummarization,
  findCompactionEvents,
  shouldCompact,
  shouldDebounceCompaction,
  MIN_MESSAGES_FOR_COMPACTION,
} from "@/lib/agent/compaction";
import {
  type TabMentionAttrs,
  type Attachment,
  extractChatMentionsFromText,
  extractTabMentionsFromText,
  formatMentionContext,
  formatChatMentionContext,
} from "@/components/chat/ChatInput";
import { listAgents } from "@/lib/agent/subagents/registry";
import { finalizeOrphanedChildrenForHeals } from "@/lib/agent/subagents/heal-orphan-children";
import {
  formatAgentMentionPrefix,
  parseAgentMentions,
} from "@/lib/chat/format-agent-mention";
import {
  buildMentionContextParts,
  extractTextContent,
  hasMeaningfulContent,
  serializeParts,
} from "@/lib/agent/serialize-parts";

// Re-export so existing tests (and any external imports) that pulled
// `serializeParts` from this module continue to resolve. The canonical
// definition lives in `lib/agent/serialize-parts.ts` so the subagent
// runner can share it.
export { serializeParts };
import { DEFAULT_AGENT_SETTINGS, DEFAULT_SETTINGS } from "@/lib/constants";
import { getMcpRegistry } from "@/lib/mcp";
import { storage } from "@/lib/storage";
import { providers as registryProviders } from "@/registry/providers";
import type {
  AgentSettings,
  CloudProvider,
  ConversationMode,
  QueuedMessage,
  SerializedToolPart,
  SerializedUIPart,
  Settings,
  ThinkingConfig,
  AgentUIMessage,
  CompactionPart,
  PlanExtensionPart,
} from "@/lib/types";
import { Chat, useChat } from "@ai-sdk/react";
import {
  isToolUIPart,
} from "ai";
import type {
  ChatTransport,
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  SourceUrlUIPart,
  StepStartUIPart,
  TextUIPart,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  buildUndoAction,
  formatClosedToast,
  performUndo,
  type AgentTabsClosedUndo,
} from "./agent-tabs-closed-toast";

type AgentMessage = AgentUIMessage;

interface UseAgentChatOptions {
  conversationId: string | null;
  spaceId: string | null;
  onNewConversation: (id: string) => void;
  /**
   * Initial value of the chat input editor. Used by the "Try in chat" flow
   * to pre-seed the input with a slash command when the home page opens
   * with a `?prefill=` URL parameter.
   */
  initialInput?: string;
  /**
   * Returns the tab id the side panel is currently "sharing" (the active
   * page pill). When a new conversation is created via `handleSubmit` /
   * `queueMessage`, the shared tab is bound into the conversation so the
   * agent sees it in the tab legend on the very first model call. Returns
   * null when the user has dismissed the pill or no eligible tab is active.
   */
  getSharedTabId?: () => number | null;
  /**
   * When set, this chat is a headless scheduled run: the transport is built
   * with the headless policy (auto-approve / approval-tool filtering) so the
   * run completes with no human present.
   */
  headless?: { autoApprove: boolean };
  /**
   * Forces the agent model for this chat instance only, WITHOUT persisting to
   * the global agent settings. Used by background scheduled runs so a task's
   * configured model doesn't overwrite the user's globally-selected model (and
   * doesn't get broadcast to other open chat instances via the agent-settings
   * storage listener). When set, this value also survives the async
   * getAgentSettings() hydration.
   */
  modelOverride?: string | null;
  /**
   * When set, a conversation created lazily by this chat (on first send) is
   * tagged with this artifact id. This is how "Edit this artifact in chat"
   * defers the conversation row until the user actually sends — so opening
   * the edit panel and closing it without typing leaves no empty row in the
   * sidebar. The agent reads `editingArtifactId` off the persisted row at
   * send time to inject the artifact's HTML for inline editing.
   */
  editingArtifactId?: string | null;
  /**
   * Initial approval mode for a NEW conversation created by `handleSubmit`
   * or `queueMessage`. Lets the user pick a mode in the composer BEFORE
   * sending the first message; otherwise `handleModeChange` in ChatView
   * silently no-ops on a null `conversationId`. Read at conversation-create
   * time only — once `conversationId` is set, mode changes go through
   * `chatDb.updateConversation` directly.
   */
  initialMode?: ConversationMode;
}

function generateId() {
  return crypto.randomUUID();
}

// `serializeParts`, `extractTextContent`, and `hasMeaningfulContent` were
// extracted to `lib/agent/serialize-parts.ts` so the subagent runner can
// reuse the exact same encoding when persisting child-conversation
// transcripts. Re-imported here under the original local names.

// `healPendingTools` (and `TOOL_HEAL_INTERRUPT_TEXT`) were extracted to
// `lib/agent/heal-pending-tools.ts` so the heal logic can be unit-tested in
// isolation without dragging this hook's heavy React/transport import graph
// into the test environment. Re-imported below.

/**
 * Writes the healed messages produced by {@link healPendingTools} back
 * to chatDb so a subsequent reload reads the post-heal shape rather
 * than the original stranded `input-available` / `approval-requested`.
 *
 * Reads existing rows first to preserve `createdAt` (chatDb sorts by
 * it on load) and any other fields like `summary` that aren't part of
 * `AgentUIMessage`.
 */
async function persistHealedMessages(
  conversationId: string | null,
  healedMessages: AgentMessage[],
): Promise<void> {
  if (!conversationId || healedMessages.length === 0) return;
  const dbMsgs = await chatDb.getMessages(conversationId);
  const byId = new Map(dbMsgs.map((m) => [m.id, m]));
  const updates: Parameters<typeof chatDb.saveMessages>[0] = [];
  for (const m of healedMessages) {
    const existing = byId.get(m.id);
    if (!existing) continue;
    const parts = serializeParts(m.parts);
    updates.push({
      ...existing,
      parts,
      content: extractTextContent(parts),
    });
  }
  if (updates.length > 0) {
    await chatDb.saveMessages(updates);
  }
  // Finalize any child conversations whose parent delegate tool call
  // was just healed. Best-effort: failures are logged but don't block
  // the heal write — the SW startup reconciliation pass will catch any
  // stragglers on next restart.
  const healedDelegateToolCallIds =
    extractHealedDelegateToolCallIds(healedMessages);
  if (healedDelegateToolCallIds.length > 0) {
    await finalizeOrphanedChildrenForHeals({
      parentConversationId: conversationId,
      healedDelegateToolCallIds,
    });
  }
}

/**
 * Collect the toolCallIds of all `delegate` parts in the healed
 * messages. These are the parents of orphaned child conversations
 * that need finalization.
 */
function extractHealedDelegateToolCallIds(
  healedMessages: AgentMessage[],
): string[] {
  const ids: string[] = [];
  for (const m of healedMessages) {
    for (const part of m.parts) {
      const p = part as Record<string, unknown>;
      const isTool =
        p.type === "dynamic-tool" ||
        (typeof p.type === "string" &&
          (p.type as string).startsWith("tool-"));
      if (!isTool) continue;
      const toolName =
        p.type === "dynamic-tool"
          ? (p.toolName as string | undefined)
          : typeof p.type === "string"
            ? (p.type as string).slice(5)
            : undefined;
      if (toolName !== "delegate") continue;
      const toolCallId =
        typeof p.toolCallId === "string" ? p.toolCallId : null;
      if (toolCallId) ids.push(toolCallId);
    }
  }
  return ids;
}

/**
 * Inverse of {@link serializeParts}. Exported alongside the serializer
 * so the round-trip contract can be tested.
 */
export function deserializePart(
  p: SerializedUIPart,
): AgentMessage["parts"][number] | null {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text } satisfies TextUIPart;
    case "reasoning":
      return { type: "reasoning", text: p.text } satisfies ReasoningUIPart;
    case "file":
      return {
        type: "file",
        mediaType: p.mediaType,
        url: p.url,
      } satisfies FileUIPart;
    case "source-url":
      return {
        type: "source-url",
        sourceId: p.sourceId,
        url: p.url,
        title: p.title,
      } satisfies SourceUrlUIPart;
    case "step-start":
      return { type: "step-start" } satisfies StepStartUIPart;
    case "data-compaction":
      // Reuse the shared `CompactionPart` shape — by construction it
      // matches the data-compaction variant of `AgentMessage["parts"][number]`.
      return { type: "data-compaction", data: p.data } satisfies CompactionPart;
    case "data-plan-extension":
      // Round-trip plan-extension markers from chatDb so the inline
      // notice survives reload. By construction the shape matches the
      // data-plan-extension variant of `AgentMessage["parts"][number]`.
      return {
        type: "data-plan-extension",
        data: p.data,
      } satisfies PlanExtensionPart;
    case "data-completion-check-rejection":
      // Round-trip the rejection block so concerns are visible after a
      // reload. The data shape matches the AgentDataParts registration,
      // so the `as never` cast is a TS artifact (the SDK widens
      // `data-${string}` types to `unknown`-data variants).
      return {
        type: "data-completion-check-rejection",
        data: p.data,
      } as never;
    case "data-mention-context":
      // Round-trip resolved mention context so the model sees the same
      // snapshot after a reload. No UI surface renders this part.
      return {
        type: "data-mention-context",
        data: p.data,
      } as never;
    case "dynamic-tool":
      return deserializeToolPart(p);
    default:
      return null;
  }
}

function deserializeToolPart(p: SerializedToolPart): DynamicToolUIPart | null {
  // Sanitize the persisted input on the way back into a live UIMessage.
  // chat-db rows from before the input-normalization fix may carry a
  // non-object `input` (Opus emitted `""` / `null` for no-arg MCP tool
  // calls and the persistence layer wrote it verbatim). Re-introducing
  // such a part to the live message list would carry the bad shape into
  // every subsequent send. The normalizer recovers stringified-JSON and
  // rawInput-style inputs; truly irrecoverable values are dropped here
  // (return null) so the live UI never sees them. The transport's
  // send-time normalizer is the eventual backstop, but dropping at
  // deserialization keeps the runtime UIMessage list clean.
  //
  // Legacy rows may also carry a `rawInput` field even though
  // `SerializedToolPart` doesn't declare it (IDB stores whole objects;
  // older versions of `serializeParts` may have written rawInput
  // through). Surface it to the normalizer so a part with
  // `{ input: undefined, rawInput: { url: "x" } }` recovers cleanly
  // instead of being treated as input-less and bypassing the rescue.
  const persistedRaw = p as unknown as Record<string, unknown>;
  const rawInput = persistedRaw.rawInput;
  const inputResult = normalizeToolInputForPersistence({
    value: p.input,
    rawValue: rawInput,
  });
  // Distinguish "input intentionally absent" (legitimate persisted shape
  // for a terminal output-error/output-denied) from "input was a
  // malformed non-object" (must be dropped). The persistence-side
  // normalizer collapses both to `drop`, so we re-check here.
  // A part with `rawInput` data is NOT intentionally absent — the writer
  // had something to record but it didn't make it into `input`. Such a
  // part falls through to the drop path only when rawInput also fails
  // recovery (covered by the normalizer).
  const inputWasIntentionallyAbsent =
    p.input === undefined && rawInput === undefined;
  let recoveredInput: unknown;
  if (inputResult.kind === "object") {
    recoveredInput = inputResult.value;
  } else if (inputWasIntentionallyAbsent) {
    recoveredInput = undefined;
  } else {
    // Present-but-malformed and non-recoverable. Drop the part so it
    // never reaches the live message list.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        `[useAgentChat] dropping persisted tool part with ` +
          `non-object input on deserialize ` +
          `(toolName=${p.toolName}, state=${p.state}, ` +
          `inputType=${typeof p.input}); see tool-input-normalize.ts.`,
      );
    }
    return null;
  }

  const base = {
    type: "dynamic-tool" as const,
    toolName: p.toolName,
    toolCallId: p.toolCallId,
  };
  if (p.state === "output-available") {
    return {
      ...base,
      state: "output-available",
      input: recoveredInput,
      output: p.output,
    };
  }
  if (p.state === "output-error") {
    return {
      ...base,
      state: "output-error",
      input: recoveredInput,
      errorText: p.errorText ?? "",
    };
  }
  if (p.state === "approval-requested" && p.approval) {
    return {
      ...base,
      state: "approval-requested",
      input: recoveredInput,
      approval: { id: p.approval.id },
    } as DynamicToolUIPart;
  }
  if (p.state === "approval-responded" && p.approval) {
    return {
      ...base,
      state: "approval-responded",
      input: recoveredInput,
      approval: p.approval as {
        id: string;
        approved: boolean;
        reason?: string;
      },
    } as DynamicToolUIPart;
  }
  return { ...base, state: "input-available", input: recoveredInput };
}

function dbMessageToUIMessage(m: {
  id: string;
  role: "user" | "assistant" | "system";
  parts: SerializedUIPart[];
}): AgentMessage {
  const parts = m.parts
    .map(deserializePart)
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return { id: m.id, role: m.role, parts };
}

interface ChatInstance {
  chat: Chat<AgentMessage>;
  conversationId: string;
  origin: "sidepanel" | "home";
}

const chatInstances = new Map<string, ChatInstance>();

function getOrCreateChat(
  conversationId: string,
  transport: ChatTransport<AgentMessage> | null,
  origin: "sidepanel" | "home" = "sidepanel",
): Chat<AgentMessage> {
  const existing = chatInstances.get(conversationId);
  if (existing) {
    // Keep the cached chat instance bound to the latest transport. The
    // transport is rebuilt whenever MCP state changes (servers connecting,
    // tools loading) via the `mcpVersion` dependency. Without this, the chat
    // stays stuck with the first non-null transport it ever received — which
    // on a fresh `home.html` load is built before MCP servers finish
    // connecting, so it has zero MCP tools baked in.
    //
    // `transport` is typed `private readonly` on AbstractChat but is a plain
    // mutable field at runtime (only read at sendMessage/resume time, so
    // swapping it between turns is safe). The cast is required to reassign it.
    if (transport) {
      (existing.chat as unknown as {
        transport: ChatTransport<AgentMessage>;
      }).transport = transport;
    }
    return existing.chat;
  }

  const chat = new Chat<AgentMessage>({
    transport: transport ?? undefined,
    generateId,
    // Resume the agent loop after the user approves a tool call. We
    // provide our own implementation instead of the SDK's
    // `lastAssistantMessageIsCompleteWithApprovalResponses`. The SDK
    // reference omits `output-denied` from its terminal set, which
    // strands tool calls that `healPendingTools` resolved to
    // `output-denied` (the resume would never fire and the approved
    // sibling call would be permanently orphaned in `approval-responded`
    // with no output). Our version adds `output-denied` so a denied/
    // healed call counts as terminal.
    //
    // We require at least one `approval-responded` part to trigger a
    // resume at all, then only resume once EVERY tool in the last step
    // has reached a terminal state. `approval-responded` is included in
    // the terminal set on purpose: the just-approved call itself sits in
    // that state, so excluding it would make `.every()` impossible to
    // satisfy. This prevents a premature resume while sibling tools are
    // still streaming, and ensures the loop picks up the approved call
    // after the rest of the step finishes.
    sendAutomaticallyWhen: ({ messages }: { messages: import("ai").UIMessage[] }) => {
      const message = messages[messages.length - 1];
      if (!message || message.role !== "assistant") return false;

      const lastStepStartIndex = message.parts.reduce(
        (lastIndex: number, part: import("ai").UIMessage["parts"][number], index: number) =>
          part.type === "step-start" ? index : lastIndex,
        -1,
      );

      const lastStepTools = message.parts
        .slice(lastStepStartIndex + 1)
        .filter(isToolUIPart);

      // Must have at least one approval response to trigger resume. This
      // guard is also load-bearing for the empty-array case: with no
      // tools, `some()` is false here so we return early and never reach
      // the `.every()` below (which would vacuously return true).
      const hasApprovalResponse = lastStepTools.some(
        (p) => p.state === "approval-responded",
      );
      if (!hasApprovalResponse) return false;

      // Every tool in the last step must be terminal. `output-denied`
      // (added vs. the SDK reference) and `approval-responded` (the
      // just-approved call awaiting execution) both count — see the
      // block comment above for why.
      return lastStepTools.every(
        (p) =>
          p.state === "output-available" ||
          p.state === "output-error" ||
          p.state === "output-denied" ||
          p.state === "approval-responded",
      );
    },
    onFinish: async ({ message }) => {
      // Clear the cross-context "agent is running" indicator. onFinish
      // fires for every terminal state (success, abort, disconnect,
      // error), so this is the single point where the active-agents
      // flag should be cleared regardless of whether the React hook
      // for this conversation is currently mounted. Pending tool
      // approval also flips status out of streaming and shouldn't
      // surface as a "running" dot — the user needs to act before the
      // agent continues.
      setAgentInactive(conversationId);

      const parts = serializeParts(message.parts);

      // Persistence is owned by the SW agent host now
      // (`agent-host/persist-stream.ts` upserts assistant messages on
      // every step boundary, including the final terminal one). The
      // renderer onFinish used to call `chatDb.saveMessage` here too;
      // doing so under SW-host would race the SW's write and produce
      // double-emit IndexedDB events. The empty-turn skip + meaningful-
      // content filter both already happen on the SW side.
      //
      // What stays renderer-side: clearing the "agent running" indicator,
      // notifying the user when the surface isn't focused, and evicting
      // the cached `Chat` instance after a grace period.

      const hasApprovalPending = parts.some(
        (p) => p.type === "dynamic-tool" && p.state === "approval-requested"
      );
      if (hasApprovalPending) {
        const approvalTool = parts.find(
          (p): p is Extract<typeof p, { type: "dynamic-tool" }> =>
            p.type === "dynamic-tool" && p.state === "approval-requested"
        );
        if (!document.hasFocus()) {
          chrome.runtime.sendMessage({
            type: "AGENT_NOTIFY",
            payload: {
              kind: "approval-needed",
              conversationId,
              snippet: approvalTool?.toolName ?? "A tool",
              origin,
            },
          });
        }
      } else {
        const textContent = extractTextContent(parts);
        if (!document.hasFocus()) {
          chrome.runtime.sendMessage({
            type: "AGENT_NOTIFY",
            payload: {
              kind: "complete",
              conversationId,
              snippet: textContent.slice(0, 80),
              origin,
            },
          });
        }
        setTimeout(() => {
          chatInstances.delete(conversationId);
        }, 5000);
      }
    },
  });

  chatInstances.set(conversationId, { chat, conversationId, origin });
  return chat;
}

// A "null" chat for when there's no active conversation
function createNullChat(transport: ChatTransport<AgentMessage> | null): Chat<AgentMessage> {
  return new Chat<AgentMessage>({
    transport: transport ?? undefined,
    generateId,
  });
}

export function useAgentChat({
  conversationId,
  spaceId,
  onNewConversation,
  initialInput,
  getSharedTabId,
  headless,
  modelOverride,
  editingArtifactId,
  initialMode,
}: UseAgentChatOptions) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(
    DEFAULT_AGENT_SETTINGS,
  );
  const [input, setInput] = useState(initialInput ?? "");
  // Mirror of `input` for callers that run after an `await` boundary,
  // where the `input` captured in a useCallback closure may be stale
  // (e.g. the `/compact` compact-then-send flow: ChatInput strips the
  // command and syncs the leftover text via onChange/setInput, then the
  // host awaits compaction before calling handleSubmit — by which point
  // the closure's `input` predates the strip). Reading the ref inside
  // handleSubmit guarantees we send the latest editor text.
  const inputRef = useRef(input);
  inputRef.current = input;

  // Mirror of `initialMode` so the conversation-create paths below
  // (handleSubmit / queueMessage) read the latest user-selected mode at
  // the moment a new conversation is minted, even if the closure was
  // captured earlier.
  const initialModeRef = useRef(initialMode);
  initialModeRef.current = initialMode;

  const [isCompacting, setIsCompacting] = useState(false);
  // Optimistic user bubble shown while a chat mention's context (possibly
  // a summary) resolves at send time. Purely visual; see handleSubmit.
  const [pendingMention, setPendingMention] = useState<{ text: string } | null>(
    null,
  );
  // Optimistic queue row shown while a queued message's chat-mention context
  // (possibly a summary) resolves at enqueue time. Purely visual; see
  // queueMessage. The real queued item replaces it once the snapshot lands.
  const [enqueuingMention, setEnqueuingMention] = useState<{
    text: string;
  } | null>(null);
  // Id of a rendered message whose mention context is being resolved
  // (summarized) in place before its first-turn dispatch — drives the chip
  // shimmer on the real bubble. Used by the deferred-resolution path (e.g.
  // sends started from the landing hero, which persist clean text and let
  // this effect summarize once the chat view is on screen).
  const [resolvingMessageId, setResolvingMessageId] = useState<string | null>(
    null,
  );
  // AbortController for the in-flight compaction summary call. The chat's
  // `stop()` cancels the agent stream; this cancels the summarization
  // LLM call separately.
  const compactionAbortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // Note: `ownerTokenRef` (the per-mount IndexedDB ownership token) was
  // removed in the SW-host migration. The SW is the single deterministic
  // host for every conversationId, so per-renderer ownership tokens are
  // moot. See `.superpowers/plans/2026-06-25-sw-host-agent-runs.md` Task 7.

  /**
   * True when a *different* live context currently owns this
   * conversation's run — i.e. this context is a read-only "viewer" that
   * mirrors the host's stream and routes actions (send/approve/stop) to
   * the owner rather than driving the loop locally.
   */
  const [isViewer, setIsViewer] = useState(false);
  const isViewerRef = useRef(false);
  isViewerRef.current = isViewer;

  // Sequence guard that drops stale/out-of-order frames received from
  // the SW host's STREAM_PARTS broadcast (viewer-receiver side).
  const seqGuardRef = useRef(new SeqGuard());
  // Wall-clock of the last mirror signal (frame or done) received as a
  // viewer. Used by the viewer watchdog to detect a host that died
  // mid-stream (no STREAM_DONE will ever arrive).
  const lastMirrorActivityRef = useRef(0);

  /**
   * Per-conversation FIFO queue of un-sent user messages. Items here
   * exist in `queue-db` but NOT in `chat-db`; they migrate at flush
   * time. State is hydrated on convId change and refreshed by the
   * `QUEUE_CHANGED` runtime broadcast emitted by `queue-db` mutations.
   *
   * The flush mutex (claim/release) lives in `queue-db` so multiple
   * panel contexts (sidepanel + detached popup) rendering the same
   * conversation can't double-send.
   */
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  /**
   * Pauses the auto-flush watcher when a queued message is currently
   * being edited in the UI. Prevents the watcher from draining the
   * very item the user is editing — which would silently turn a Save
   * click into a no-op against `queue-db.update` (the row would be
   * gone). Set/cleared by the consumer (`ChatView`) via the
   * `setQueueEditing` callback below.
   *
   * Stored as a ref because the watcher already depends on `queue`
   * and `status`; we don't need re-runs purely from this flag, only
   * for the existing deps to re-evaluate against the latest value.
   */
  const queueEditingIdRef = useRef<string | null>(null);
  const setQueueEditing = useCallback((id: string | null) => {
    queueEditingIdRef.current = id;
  }, []);

  useEffect(() => {
    storage.getSettings().then(setSettings);
    storage.getAgentSettings().then((loaded) =>
      setAgentSettings(
        modelOverride ? { ...loaded, agentModel: modelOverride } : loaded,
      ),
    );
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local") {
        if (changes.settings) storage.getSettings().then(setSettings);
        if (changes["agent-settings"])
          storage.getAgentSettings().then((loaded) =>
            setAgentSettings(
              modelOverride
                ? { ...loaded, agentModel: modelOverride }
                : loaded,
            ),
          );
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [modelOverride]);

  /**
   * Hydrate the per-conversation queue and keep it in sync with both
   * local mutations (this same panel calling enqueue/remove/etc.) and
   * cross-context mutations (a sibling panel mutating the same convId).
   *
   * We subscribe to BOTH because `chrome.runtime.sendMessage` does not
   * deliver to its own sender — without the in-process pubsub, the
   * panel that just called `queueMessage` would never refresh its own
   * `queue` state, and the auto-flush watcher's `[queue]` dependency
   * would never re-fire. Cross-context still goes through
   * `chrome.runtime.onMessage` so a popup mutating the same convId
   * also lands here.
   */
  useEffect(() => {
    if (!conversationId) {
      setQueue([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const items = await queueDb.list(conversationId);
      if (!cancelled) setQueue(items);
    };
    refresh();

    const unsubLocal = subscribeQueueChange((cid) => {
      if (cid === conversationId) refresh();
    });

    const onMessage = (msg: { type: string; conversationId?: string }) => {
      if (msg.type === "QUEUE_CHANGED" && msg.conversationId === conversationId) {
        refresh();
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);

    return () => {
      cancelled = true;
      unsubLocal();
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [conversationId]);

  const mcpConnectionKey = settings.mcpServers
    .filter((s) => s.enabled)
    .map((s) => `${s.id}:${s.url}`)
    .join(",");

  const [mcpVersion, setMcpVersion] = useState(0);

  useEffect(() => {
    return getMcpRegistry().subscribe(() => {
      setMcpVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (settings.mcpServers.length > 0) {
      getMcpRegistry().connectAll(settings.mcpServers);
    } else {
      getMcpRegistry().refreshStates();
    }
  }, [mcpConnectionKey]);

  // Eagerly cache the working-overlay glow color for this conversation
  // BEFORE the first tool runs. The SW agent-transport tool wrapper looks
  // up via `getAgentColor(cid)` and falls back to a lazy storage read if
  // unset, but the lazy path means the first tool call paints with default
  // tint until the read completes. Setting it here from the renderer side
  // is a renderer-realm convenience (the SW realm also resolves it on
  // demand). Cleared to null whenever the conversation has no space.
  useEffect(() => {
    if (!conversationId) return;
    if (!spaceId) {
      setAgentColor(conversationId, null);
      return;
    }
    storage.getSpaces().then((spaces) => {
      const space = spaces.find((s) => s.id === spaceId);
      setAgentColor(conversationId, space?.colors?.[0] ?? null);
    });
  }, [conversationId, spaceId]);

  const [hasVisionSupport, setHasVisionSupport] = useState(true);

  const isConfigured = useMemo(() => {
    if (!agentSettings.agentModel) return false;
    
    const [providerId, ...modelIdParts] = agentSettings.agentModel.split(":");
    const actualModelId = modelIdParts.length > 0 ? modelIdParts.join(":") : agentSettings.agentModel;

    // Find the provider
    const configuredProvider = registryProviders.find((p) => {
      if (modelIdParts.length > 0) {
        if (p.id !== providerId) return false;
      } else {
        if (!p.models.some((m) => m.id === actualModelId)) return false;
      }
      
      if (p.setup === "byok") {
        const config = settings.providerConfigs[p.id] ?? {};
        const requiredFields = p.configSchema?.filter((f) => f.required) ?? [];
        return requiredFields.every((f) => !!config[f.key]);
      } else {
        return settings.downloadedModels.includes(actualModelId);
      }
    });

    return !!configuredProvider;
  }, [agentSettings.agentModel, settings.providerConfigs, settings.downloadedModels, registryProviders]);

  useEffect(() => {
    if (!agentSettings.agentModel) return;
    const [providerId, ...modelIdParts] = agentSettings.agentModel.split(":");
    const actualModelId = modelIdParts.length > 0 ? modelIdParts.join(":") : agentSettings.agentModel;

    import("@/registry/providers").then(({ providers }) => {
      const provider = providers.find((p) => {
        if (modelIdParts.length > 0) {
          if (p.id !== providerId) return false;
        } else {
          if (!p.models.some((m) => m.id === actualModelId)) return false;
        }
        
        if (p.setup === "byok") {
          const config = settings.providerConfigs[p.id] ?? {};
          const requiredFields = p.configSchema?.filter((f) => f.required) ?? [];
          return requiredFields.every((f) => !!config[f.key]);
        } else {
          return settings.downloadedModels.includes(actualModelId);
        }
      }) || providers.find((p) => p.models.some((m) => m.id === actualModelId));

      if (provider?.setup === "web-llm" || provider?.setup === "browser-ai") {
        const model = provider.models.find((m) => m.id === actualModelId);
        if (model?.capabilities.includes("vision")) {
          setHasVisionSupport(true);
          return;
        }
      }
      setHasVisionSupport(true);
    });
  }, [agentSettings.agentModel, settings.providerConfigs, settings.downloadedModels]);

  const [transport, setTransport] = useState<ChatTransport<AgentMessage> | null>(null);

  // Build the RemoteChatTransport. The actual agent loop now lives in the
  // service worker (see `.superpowers/plans/2026-06-25-sw-host-agent-runs.md`);
  // this renderer-side transport is a thin proxy that opens a per-conversation
  // Port and pumps SW-emitted chunks into the AI SDK's `Chat`/`useChat`.
  //
  // The transport is rebuilt when the renderer-side settings snapshot (model,
  // space, thinking config, headless policy) changes. Re-keying the transport
  // makes the freshly opened port carry the up-to-date `settingsSnapshot` on
  // its first AGENT_RUN_START; the SW reads global settings (provider configs,
  // MCP servers, ...) from storage itself.
  useEffect(() => {
    if (!conversationId) {
      setTransport(null);
      return;
    }
    if (!agentSettings.agentModel) {
      setTransport(null);
      return;
    }
    const origin: "sidepanel" | "home" | "newtab" | "popup" =
      typeof window !== "undefined" &&
      window.location.pathname.includes("newtab")
        ? "newtab"
        : typeof window !== "undefined" &&
          window.location.pathname.includes("home")
        ? "home"
        : typeof window !== "undefined" &&
          window.location.search.includes("mode=popup")
        ? "popup"
        : "sidepanel";
    const t = new RemoteChatTransport(
      conversationId,
      {
        agentModel: agentSettings.agentModel,
        spaceId: spaceId ?? null,
        thinkingEnabled: agentSettings.thinkingEnabled,
        thinkingConfig: agentSettings.thinkingConfig,
        headless,
      },
      origin,
    );
    setTransport(t);
    return () => {
      // No teardown needed — opening a fresh transport just means the
      // next sendMessages will open a fresh Port. The SW keeps the run
      // alive across renderer re-mounts.
    };
  }, [
    conversationId,
    agentSettings.agentModel,
    agentSettings.thinkingEnabled,
    agentSettings.thinkingConfig,
    spaceId,
    mcpVersion,
    headless?.autoApprove,
  ]);

  // Get or create a Chat instance for the current conversation
  const origin: "sidepanel" | "home" = window.location.pathname.includes("home")
    ? "home"
    : "sidepanel";

  const chat = useMemo(() => {
    if (!conversationId || !transport) return createNullChat(transport);
    return getOrCreateChat(conversationId, transport, origin);
  }, [conversationId, transport]);

  const {
    messages,
    setMessages,
    sendMessage,
    regenerate,
    status,
    stop: chatStop,
    error,
    clearError,
    addToolApprovalResponse,
  } = useChat<AgentMessage>({ chat });

  // Mirror of `messages` for callbacks that run after an `await` boundary,
  // where the `messages` captured in a useCallback closure may be stale.
  // Specifically: the compact-then-send flow awaits `compactNow()` (which
  // appends the compaction marker + summary via `setMessages`) before
  // invoking `handleSubmit`. The `handleSubmit` instance captured in
  // ChatView's `onCommand` closure predates that update, so its closed-over
  // `messages` lacks the marker. Reading the ref in `handleSubmit`'s heal
  // pass ensures we heal/append against the CURRENT chat state — otherwise
  // a stranded-tool heal would `setMessages` a marker-less array and the
  // transport would ship the full (un-compacted) history to the model.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Forward ref to `queueMessage` (defined below, after `handleSubmit`).
  // `handleSubmit` needs to be able to divert to the queue when the SW
  // probe reports an active run; without a forward ref we'd have an
  // init-order problem (handleSubmit captures queueMessage before it's
  // defined). The ref is assigned right after `queueMessage`'s
  // useCallback returns.
  const queueMessageRef = useRef<
    ((
      mentions?: TabMentionAttrs[],
      attachments?: Attachment[],
    ) => Promise<void>) | null
  >(null);

  // Track whether an explicit user-driven stop happened so the next
  // AGENT_RUN_DONE for this conversation can force a chatDb rehydrate
  // even when this renderer is mid-loading-state on the FOLLOW-UP turn.
  // Without this, the side panel's in-memory `messages` for the aborted
  // turn can diverge from the persisted (healed) version: chunks keep
  // flowing through the local Chat for a moment after stop() fires,
  // and the standard `isLoadingRef.current` gate in the DONE handler
  // skips re-hydrate when the queue auto-flush has already started a
  // new turn. See `mergeChatDbWithLocal` for the convergence logic.
  const forceRehydrateOnNextDoneRef = useRef(false);

  // Wrap the chat's stop() so it also aborts any in-flight compaction
  // summarization call. Without this, clicking Stop while a summary is
  // generating would silently let the LLM call continue and write a
  // compaction event into the chat after the user thought they had
  // cancelled.
  //
  // Also fires `abortAgentRun` against the SW so that *viewer* surfaces
  // (whose local `useChat` is in `status: "ready"` because they didn't
  // start the run) can still kill the SW-side run. `chatStop()` alone
  // aborts only the local AI SDK stream — which for a viewer is a
  // no-op against an already-idle local Chat — and would leave the SW
  // run executing tools in the background.
  // Aborts the deferred mention-context resolution (summary) running in the
  // first-turn dispatch, so Stop cancels it just like a live compaction.
  const mentionResolveAbortRef = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    compactionAbortRef.current?.abort();
    mentionResolveAbortRef.current?.abort();
    forceRehydrateOnNextDoneRef.current = true;
    chatStop();
    const cid = conversationIdRef.current;
    if (cid) abortAgentRun(cid);
  }, [chatStop]);

  // `isInitiator` is true only when *this* renderer's local `useChat`
  // is actively driving a run. Used by listeners that need to gate on
  // "am I the source of truth for the local message list" — e.g. the
  // STREAM_PARTS receiver, which must skip applying snapshots when the
  // local chunk stream is already updating messages.
  const isInitiator = status === "submitted" || status === "streaming";
  // `isLoading` is what the UI uses to decide whether to show the Stop
  // button + spinner. It must be true for BOTH initiators (this tab
  // started the run) AND viewers (a different surface — or the SW
  // continuing after all tabs were closed — is driving the run, and
  // this surface is mirroring via STREAM_PARTS). Without the
  // `isViewer` arm here the side panel would show the Send button as
  // if the chat were idle while the SW is busy executing tools, and
  // the auto-flush watcher would happily race the active SW run.
  const isLoading = isInitiator || isViewer || resolvingMessageId !== null;
  
  // `isStreaming` is used by the MessageList to decide if the *entire
  // conversation* is active, which controls whether the latest tool
  // call shows as "Pending..." vs "Interrupted". If we just used
  // `status === "streaming"`, the UI would instantly flash the tool as
  // "Interrupted" the moment the AI SDK finished generating text and
  // handed execution off to the tool (because SDK status drops to
  // "ready" while tools run). Syncing this to `isLoading` keeps tools
  // marked as "Pending/Running" for as long as the SW is running them.
  const isStreaming = isLoading;
  const wasLoadingRef = useRef(false);
  // Tracks whether THIS renderer was the initiator at any point during
  // the current loading window. Distinct from `wasLoadingRef` (which
  // mirrors `isLoading = isInitiator || isViewer`) so the post-turn
  // compaction block only fires for the renderer that actually drove
  // the run. Without this gate, every viewer surface watching the run
  // would also enter the compaction branch when `isLoading` flips to
  // false (e.g. on STREAM_DONE), duplicating the "Continue" turn.
  const wasInitiatorRef = useRef(false);
  // Mirror `isInitiator` for use in cross-context listeners that need
  // to know "is THIS renderer actively driving the run right now?"
  // without the effect rebinding on every status flip. Used by the
  // STREAM_PARTS receiver to avoid double-applying snapshots in the
  // initiator renderer (whose `useChat` is already updating messages
  // from the live chunk stream). Named `isLoadingRef` historically;
  // semantics are now strictly "am I the initiator", not "am I in a
  // loading-display state" (those diverge for viewer surfaces).
  const isLoadingRef = useRef(isInitiator);
  isLoadingRef.current = isInitiator;

  const runCompaction = useCallback(
    async (
      convId: string,
      msgs: AgentMessage[],
      opts?: { auto?: boolean; overflow?: boolean; manual?: boolean },
    ) => {
      const manual = opts?.manual ?? false;
      if (msgs.length < MIN_MESSAGES_FOR_COMPACTION) {
        if (manual) toast.info("Conversation is too short to compact yet");
        return;
      }

      // Time-based debounce thrash detection. If we just compacted within
      // COMPACTION_DEBOUNCE_MS, don't compact again — covers the case
      // where the produced summary itself overflows and would otherwise
      // loop. Reads directly from the visible message list, so the UI
      // and the runtime agree on what counts.
      //
      // Manual `/compact` is user-initiated and can't loop, so it skips
      // the debounce — otherwise a user who just auto-compacted would
      // click `/compact` and see nothing happen.
      const dbMessages = await chatDb.getMessages(convId);
      const events = findCompactionEvents(dbMessages);
      if (!manual && shouldDebounceCompaction(events)) return;

      const auto = opts?.auto ?? true;
      const overflow = opts?.overflow ?? false;

      const abortController = new AbortController();
      compactionAbortRef.current = abortController;
      setIsCompacting(true);
      try {
        // Build prunable view of the current chat for tail selection +
        // summary input. We don't apply the result back to the chat —
        // pruning at send time happens in CompactingChatTransport.
        const prunableMessages = msgs.map((m) => ({
          id: m.id,
          role: m.role,
          parts: serializeParts(m.parts),
          createdAt: 0,
        }));

        const { pruned } = pruneMessageParts(prunableMessages);
        const modelDef = getCurrentModelDef();

        // Compute the tail boundary. The CompactionPart will anchor here so
        // the transport's filterCompactedMessages knows where to keep the
        // verbatim tail and where to drop the head.
        //
        // Manual `/compact` summarizes the whole conversation and keeps
        // no verbatim tail (`tailStartId === undefined`), so it gates only
        // on having a non-empty head. Auto-compaction still requires a
        // tail anchor (it preserves recent turns verbatim to continue).
        const { headMessages, tailStartId } = manual
          ? selectTailForManual(pruned)
          : selectTail(pruned, modelDef);
        if (manual ? headMessages.length === 0 : !tailStartId || headMessages.length === 0) {
          if (manual) toast.info("Conversation is too short to compact yet");
          return;
        }

        // Always run summarization. We previously had a "prune-only fast
        // path" that skipped the LLM call when pruning would free enough
        // tokens, writing a compaction event with an empty summary
        // assistant message. That broke the AI SDK's Zod validation
        // ("Message must contain at least one part") on the next send and
        // produced no real benefit — `prunePartsAtSendTime` already runs
        // unconditionally on every send via the transport, more
        // aggressively than `pruneMessages` (no PRUNE_PROTECT budget). So
        // the only effect of the fast path was a useless empty message.
        //
        // OpenCode treats pruning as a separate, silent operation from
        // compaction events; we now match that. If the threshold check
        // triggered runCompaction, we always summarize.
        const conversationText = prepareMessagesForSummarization(headMessages);
        // Carry the previous summary forward so the new one is an
        // anchored update, not a fresh start. OpenCode does the same
        // via `previousSummary` in their compaction prompt.
        const previousSummary = events.at(-1)?.summaryText;
        const userPrompt = buildCompactionPrompt(previousSummary);

        const { generateText } = await import("ai");
        const agentSettingsForCompaction = await storage.getAgentSettings();
        const settingsForCompaction = await storage.getSettings();
        const compactionModelId =
          agentSettingsForCompaction.compactionModel ||
          agentSettingsForCompaction.agentModel;

        const { providers } = await import("@/registry/providers");
        // Model keys are stored composite ("providerId:modelId"); resolve
        // to a provider + bare model id. Comparing the composite key
        // directly against the registry's bare model ids was the bug
        // behind "no provider for compaction model" (and silent
        // auto-compaction failures).
        const resolved = resolveCompactionModel(compactionModelId, providers);
        if (!resolved) {
          if (manual) {
            toast.error("Can't compact: no provider for the compaction model");
          }
          return;
        }

        const config =
          settingsForCompaction.providerConfigs[resolved.provider.id] ?? {};
        const compactionModel = await resolved.provider.createLanguageModel(
          config,
          resolved.modelId,
        );

        const result = await generateText({
          model: compactionModel,
          system: getCompactionSystemPrompt(),
          prompt: conversationText + "\n\n" + userPrompt,
          abortSignal: abortController.signal,
        });
        const summaryText = result.text.trim();

        // If the user aborted while the summary call was in flight, bail
        // before persisting anything.
        if (abortController.signal.aborted) return;

        // Defensive: if the model returned empty text, don't persist a
        // compaction event with an empty assistant message — that would
        // fail Zod validation on subsequent sends. Just abort the
        // compaction silently; the next overflow trigger will retry.
        if (!summaryText) {
          console.warn(
            "[compaction] summary model returned empty text; skipping event",
          );
          if (manual) {
            toast.error("Compaction failed: the model returned no summary");
          }
          return;
        }

        // Persist the compaction event as two messages.
        const now = Date.now();
        const compactionUserId = generateId();
        const summaryAssistantId = generateId();

        const compactionPart: CompactionPart = {
          type: "data-compaction",
          data: {
            auto,
            ...(overflow ? { overflow: true } : {}),
            tailStartMessageId: tailStartId,
          },
        };

        await chatDb.saveMessage({
          id: compactionUserId,
          conversationId: convId,
          role: "user",
          content: "",
          parts: [compactionPart],
          createdAt: now,
        });

        const summaryParts: SerializedUIPart[] = [
          { type: "text", text: summaryText },
        ];
        await chatDb.saveMessage({
          id: summaryAssistantId,
          conversationId: convId,
          role: "assistant",
          content: summaryText,
          parts: summaryParts,
          createdAt: now + 1,
          summary: true,
        });

        // Reflect both new messages in the chat instance so the UI
        // updates immediately and so `sendMessage("Continue...")` below
        // sees them in the messages array.
        const compactionUiMsg: AgentMessage = {
          id: compactionUserId,
          role: "user",
          parts: [compactionPart],
        };
        const summaryUiMsg: AgentMessage = {
          id: summaryAssistantId,
          role: "assistant",
          parts: [{ type: "text", text: summaryText }],
        };
        setMessages([...msgs, compactionUiMsg, summaryUiMsg]);

        // Manual `/compact` has no auto-continue, so the only signal that
        // it worked is the new divider in the stream — confirm with a
        // toast so the action feels acknowledged.
        if (manual) {
          toast.success("Conversation compacted");
        }

        // Auto-continue: send a synthetic user message asking the agent
        // to resume. Manual /compact (follow-up) would skip this. The
        // wording matches OpenCode's continue prompt.
        if (auto) {
          // Heal pending tool calls in the pre-compaction tail so the
          // continue message doesn't leave the conversation in an
          // invalid tool_use-without-tool_result state. Mirrors
          // `handleSubmit`. We pass `msgs` (the pre-compaction list)
          // because the newly-added compaction marker + summary have
          // no tool parts.
          const { healed, healedMessages } = healPendingTools(
            msgs,
            "Superseded by auto-compaction continue",
          );
          if (healedMessages.length > 0) {
            setMessages([...healed, compactionUiMsg, summaryUiMsg]);
            await persistHealedMessages(convId, healedMessages);
          }

          const continueText = overflow
            ? "The previous request exceeded the context window. The conversation was compacted. Continue where you left off, or ask for clarification if unsure how to proceed."
            : "Continue where you left off, or ask for clarification if unsure how to proceed.";
          // Synthetic continue message — intentionally not persisted to
          // chatDb (the compaction marker + summary above stand in for
          // it, so on refresh the conversation resumes from the summary
          // without resurrecting this prompt). We still pass an explicit
          // id rather than letting the SDK auto-generate one, purely
          // for consistency with the other `sendMessage` call sites
          // (`handleSubmit`, queue-flush, `confirmEdit`); behavior is
          // unchanged because nothing reads this id from chatDb.
          sendMessage({
            id: generateId(),
            role: "user",
            parts: [{ type: "text", text: continueText }],
          });
        }
      } catch (err) {
        if (
          (err as { name?: string })?.name === "AbortError" ||
          abortController.signal.aborted
        ) {
          // User-initiated stop — silent.
          return;
        }
        console.error("[compaction] failed:", err);
        if (manual) {
          toast.error(
            `Compaction failed: ${(err as Error)?.message ?? String(err)}`,
          );
        }
      } finally {
        if (compactionAbortRef.current === abortController) {
          compactionAbortRef.current = null;
        }
        setIsCompacting(false);
      }
    },
    [sendMessage, setMessages],
  );

  /**
   * Manually compact the current conversation (the `/compact` slash
   * command). Passes `manual: true` so `runCompaction`:
   *   - uses `selectTailForManual` (preserve only the last user turn,
   *     ignore the token budget) so small conversations still compact,
   *   - skips the thrash debounce,
   *   - surfaces user-visible toasts for every outcome (success, too
   *     short, provider/model failure) instead of silently no-op'ing,
   *   - does NOT auto-continue (no synthetic "Continue…" turn) — the
   *     user controls what happens next (the composer's compact-then-send
   *     flow may send leftover text afterwards).
   *
   * Resolves once compaction has finished (or was skipped), so callers
   * can `await` it before sending a follow-up message and rely on the
   * transport pruning against the fresh compaction state.
   */
  const compactNow = useCallback(async (): Promise<void> => {
    const convId = conversationIdRef.current;
    if (!convId) {
      toast.info("Nothing to compact yet");
      return;
    }
    if (isCompacting) {
      toast.info("Already compacting…");
      return;
    }
    if (isLoading) {
      toast.info("Can't compact while the agent is responding");
      return;
    }
    // `runCompaction({ manual: true })` owns the remaining feedback:
    // it toasts "too short to compact" / failure / success itself.
    await runCompaction(convId, messages, { auto: false, manual: true });
  }, [isCompacting, isLoading, messages, runCompaction]);

  useEffect(() => {
    if (isInitiator) {
      wasInitiatorRef.current = true;
    }
    if (isLoading) {
      wasLoadingRef.current = true;
      if (conversationId) {
        setAgentActive(conversationId);
        // Under the SW-host model the service worker owns the single
        // deterministic host for every conversation. We no longer claim
        // ownership in IndexedDB here — there is no cross-renderer
        // contention because every renderer is now a subscriber, not
        // a host candidate.
      }
    } else if (wasLoadingRef.current) {
      wasLoadingRef.current = false;
      // Snapshot + reset `wasInitiatorRef` for the next loading window.
      // The compaction gate below honors the snapshot so a viewer-only
      // surface (`wasInitiator === false`) never reaches `runCompaction`.
      const wasInitiator = wasInitiatorRef.current;
      wasInitiatorRef.current = false;
      // Under SW-host the authoritative `resetAgentIndicator()` call
      // happens in the SW agent host's terminal-state handler (see
      // `entrypoints/background/agent-host/run.ts`) — that's the realm
      // where `agentActive` was flipped true by the tool wrapper and
      // where `chrome.debugger` sessions were attached. This call is a
      // defensive no-op in the renderer realm (the renderer's
      // `agentActive` is always false post-SW-host) but is kept to
      // tear down any future renderer-side overlay state cleanly.
      // Pass the cid so the per-tab teardown only touches THIS
      // conversation's overlays — peer parallel runs are not disturbed.
      resetAgentIndicator(conversationId ?? null);
      if (conversationId) {
        setAgentInactive(conversationId);
        // Terminal-state broadcast is owned by the SW host now
        // (`agent-host/snapshot-broadcast.ts`'s `done()` emits the final
        // STREAM_PARTS + STREAM_DONE). The renderer no longer needs to
        // re-emit on its `status` transition.
      }

      // Check if compaction is needed after response completes. This
      // covers both true inter-turn compaction and mid-stream compaction
      // (where `stopWhen` in agent-transport caused the agent loop to
      // exit early at a step boundary because tokens crossed the
      // threshold). Either way, status flips out of streaming and we
      // land here.
      //
      // Gated on `wasInitiator`: viewer surfaces also pass through this
      // branch when the run finishes (their `isLoading` flips from true
      // to false via `isViewer` dropping). A viewer must NOT enter
      // `runCompaction` — that would race the initiator's compaction
      // and duplicate the "Continue" turn injection.
      //
      // Under SW-host the agent loop runs in a different realm than this
      // hook, so the legacy `needsCompaction()` (which read a
      // module-scope `lastTotalTokens` mutated by the loop) always
      // returned false here. We instead read the authoritative
      // `conv.usage.totalTokens` that the SW persists to chat-db on
      // every step, and feed it directly to `shouldCompact`.
      if (
        wasInitiator &&
        conversationId &&
        messages.length >= MIN_MESSAGES_FOR_COMPACTION
      ) {
        const cid = conversationId;
        const localMessages = messages;
        void chatDb.getConversation(cid).then((conv) => {
          if (!conv?.usage) return;
          if (conversationIdRef.current !== cid) return;
          // Build a TokenLimits-shaped view of the persisted snapshot so
          // `shouldCompact` has the right ceiling for the model the SW
          // actually used this turn (rather than falling back to the
          // renderer's stale `currentModelDef`, which is no longer
          // mutated by the agent loop under SW-host).
          const modelLimits = {
            contextWindow: conv.usage.contextWindow,
            maxOutputTokens: getCurrentModelDef()?.maxOutputTokens,
          };
          if (shouldCompact(conv.usage.totalTokens, modelLimits)) {
            runCompaction(cid, localMessages, { auto: true });
          }
        });
      }
    }
  }, [status, conversationId, messages, runCompaction, stop, isViewer, isInitiator]);

  // Heartbeat + host-broadcaster effects intentionally removed.
  //
  // Pre-SW-host architecture: every renderer ran its own agent loop and
  // arbitrated single-host status via an IndexedDB ownership lock with
  // 10s heartbeat + 30s stale threshold (`runOwnership`), and the
  // elected host emitted throttled STREAM_PARTS snapshots to viewer
  // surfaces. Both effects lived here.
  //
  // Post-SW-host architecture (this branch): the service worker is the
  // single deterministic host for every conversationId. Every renderer
  // is a subscriber via `RemoteChatTransport`. The SW emits the same
  // STREAM_PARTS snapshots via `agent-host/snapshot-broadcast.ts`, so
  // the receive side below is unchanged. The heartbeat / broadcaster
  // effects are net-removed.

  // Viewer receiver: any renderer surface displays mirrored snapshots
  // from the SW host into the local message list and converges on the
  // authoritative transcript when the turn finishes. Under SW-host this
  // is the universal "catch-up after the renderer was frozen" channel.
  useEffect(() => {
    if (!conversationId) return;
    const cid = conversationId;
    const guard = seqGuardRef.current;

    const onMessage = (msg: unknown) => {
      if (isStreamPartsMessage(msg) && msg.conversationId === cid) {
        lastMirrorActivityRef.current = Date.now();
        // Under SW-host the SW broadcasts STREAM_PARTS to EVERY open
        // renderer — including the one that initiated this run. The
        // initiator's `useChat` is already pulling chunks from the
        // RemoteChatTransport's ReadableStream and applying them to the
        // local message list. Applying the SW's snapshot on top would
        // race the chunk pipeline and could clobber the local in-flight
        // message with a slightly-stale snapshot. So if THIS renderer is
        // actively loading (status is `streaming` / `submitted`), we
        // skip the snapshot — the chunk stream is the authoritative
        // source for the initiator. Renderers that are NOT actively
        // loading are viewers: the snapshot is exactly what they need.
        if (isLoadingRef.current) return;
        if (!isViewerRef.current) setIsViewer(true);
        if (!guard.shouldApply(msg.messageId, msg.seq)) return;
        const snapshot = dbMessageToUIMessage({
          id: msg.messageId,
          role: "assistant",
          parts: msg.parts,
        });
        setMessages((prev) => applyStreamSnapshot(prev, snapshot));
        return;
      }
      if (isStreamDoneMessage(msg) && msg.conversationId === cid) {
        // SW host finished the turn. Re-read the persisted transcript so
        // we converge on the authoritative state (covers any dropped
        // frame) and drop viewer mode. Skip for the initiator renderer:
        // its `useChat.onFinish` already ran with the live message state.
        lastMirrorActivityRef.current = Date.now();
        const forceRehydrate = forceRehydrateOnNextDoneRef.current;
        if (forceRehydrate) {
          // Post-stop convergence: the user clicked Stop on the previous
          // turn. The local Chat instance kept accumulating chunks for
          // the aborted message after `stop()` (chunks in-flight on the
          // disconnected port + provider's tail emission). The
          // queue/handleSubmit path persisted a HEALED version of the
          // aborted message to chatDb; rehydrate against that and
          // preserve any in-flight new turn (local-only messages).
          forceRehydrateOnNextDoneRef.current = false;
          guard.reset();
          void chatDb.getMessages(cid).then((dbMsgs) => {
            if (conversationIdRef.current !== cid) return;
            if (dbMsgs.length === 0) return;
            const dbUiMsgs = dbMsgs.map(dbMessageToUIMessage);
            setMessages((local) => mergeChatDbWithLocal(dbUiMsgs, local));
            // Defensively clear viewer mode here too. The forceRehydrate
            // flag is normally set by the initiator's `stop()`, where
            // `isViewer` is already false — but viewer surfaces also
            // route their stop through the same `abortAgentRun` helper
            // and can hit this branch with `isViewer === true`. Without
            // this clear, the viewer's UI would stay in spinner/Stop
            // mode after the stop succeeded.
            if (isViewerRef.current) setIsViewer(false);
          });
          return;
        }
        if (isLoadingRef.current) return;
        guard.reset();
        void chatDb.getMessages(cid).then((dbMsgs) => {
          if (conversationIdRef.current !== cid) return;
          // Only adopt the DB transcript if it actually has content. An
          // errored/empty turn may not have persisted the in-flight
          // assistant message (onFinish skips empty turns), and the host's
          // self-heal can delete a trailing empty assistant row — in
          // either case we must NOT blow away what the viewer already
          // mirrored down to an empty list. Keep the mirrored messages if
          // the DB has nothing.
          if (dbMsgs.length > 0) {
            setMessages(dbMsgs.map(dbMessageToUIMessage));
          }
          setIsViewer(false);
        });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [conversationId, setMessages]);

  // Viewer watchdog: if this renderer is mirroring an SW-hosted run but
  // the SW dies mid-stream (memory pressure, browser update) and the
  // STREAM_DONE never arrives, the viewer would stay stuck read-only
  // forever. Periodically check: if no mirror activity for a while,
  // exit viewer mode and re-read whatever the SW last persisted to
  // chat-db. Under SW-host there is no IDB ownership probe — the SW
  // either has a live run (and is emitting STREAM_PARTS) or it doesn't.
  // A long idle implies the latter.
  const VIEWER_STALE_MS = 30_000;
  const VIEWER_CHECK_MS = 10_000;
  useEffect(() => {
    if (!conversationId) return;
    if (!isViewer) return;
    const cid = conversationId;
    const interval = setInterval(() => {
      const idle = Date.now() - lastMirrorActivityRef.current;
      if (idle < VIEWER_STALE_MS) return;
      void chatDb.getMessages(cid).then((dbMsgs) => {
        if (conversationIdRef.current !== cid) return;
        if (dbMsgs.length > 0) {
          setMessages(dbMsgs.map(dbMessageToUIMessage));
        }
        seqGuardRef.current.reset();
        setIsViewer(false);
      });
    }, VIEWER_CHECK_MS);
    return () => clearInterval(interval);
  }, [conversationId, isViewer, setMessages]);

  // Initiator watchdog: symmetric to the viewer watchdog above.
  //
  // The initiator surface drives a run via `RemoteChatTransport`. Chunks
  // flow back over a `chrome.runtime.connect` port. The AI SDK's local
  // `Chat` instance stays in `streaming` status until the chunk stream
  // closes (via AGENT_RUN_DONE or port disconnect). If the port
  // mechanism gets disrupted — e.g. the SW broadcasts DONE but the
  // chunk-pump's onMessage never delivers it, or the port half-closes
  // on disconnect without erroring the controller — `Chat.status` stays
  // at `streaming` forever. Consequences:
  //
  //   - `queue.length > 0` waits forever (auto-flush gates on `ready`).
  //   - UI shows a perpetual tool-running indicator.
  //   - User has no way to recover except reload.
  //
  // Recovery: if `Chat.status` is `streaming`/`submitted` and `messages`
  // hasn't changed for `INITIATOR_STALE_MS` AND chatDb's last assistant
  // message is in clean terminal state (no `input-streaming` parts, no
  // `approval-requested`), force convergence:
  //
  //   1. Call `chat.stop()` to best-effort abort the activeResponse.
  //   2. Force-set status to `ready` via the AI SDK's internal
  //      `setStatus` (typed as `private` but accessible at runtime).
  //   3. Re-hydrate `messages` from chatDb.
  //   4. The queue auto-flush effect re-runs on the status change and
  //      drains any pending message.
  //
  // The viewer watchdog only fires when `isViewer === true`; this one
  // fires only when `isInitiator === true` (this renderer's `useChat`
  // is the source of truth, and its local chunk pump has gone idle).
  //
  // See `shouldRecoverFromStuckStreaming` in `stream-mirror.ts` for the
  // exact decision logic and its rationale.
  const lastChunkActivityRef = useRef(Date.now());
  useEffect(() => {
    lastChunkActivityRef.current = Date.now();
  }, [messages]);

  const INITIATOR_STALE_MS = 30_000;
  const INITIATOR_CHECK_MS = 10_000;
  useEffect(() => {
    if (!conversationId) return;
    if (!isInitiator) return;
    const cid = conversationId;
    const interval = setInterval(async () => {
      try {
        const dbMsgs = await chatDb.getMessages(cid);
        if (conversationIdRef.current !== cid) return;
        const lastAssistantParts = (() => {
          for (let i = dbMsgs.length - 1; i >= 0; i--) {
            if (dbMsgs[i].role === "assistant") {
              return dbMsgs[i].parts;
            }
          }
          return undefined;
        })();
        const should = shouldRecoverFromStuckStreaming({
          status: status as "ready" | "submitted" | "streaming" | "error",
          lastActivityMs: lastChunkActivityRef.current,
          now: Date.now(),
          idleThresholdMs: INITIATOR_STALE_MS,
          dbLastAssistantParts: lastAssistantParts as
            | ReadonlyArray<{ type: string; state?: string }>
            | undefined,
        });
        if (!should) return;
        // Recover: stop the activeResponse, reset status, converge state.
        try {
          await chat.stop();
        } catch {
          // best-effort
        }
        try {
          (chat as unknown as {
            setStatus: (s: { status: string; error?: unknown }) => void;
          }).setStatus({ status: "ready" });
        } catch {
          // best-effort — if the SDK rejects the cast, fall through
        }
        if (dbMsgs.length > 0) {
          setMessages(dbMsgs.map(dbMessageToUIMessage));
        }
        // Bump activity so the watchdog doesn't immediately re-fire if
        // status takes a tick to propagate.
        lastChunkActivityRef.current = Date.now();
      } catch {
        // chatDb lookup failed; try again next interval.
      }
    }, INITIATOR_CHECK_MS);
    return () => clearInterval(interval);
  }, [conversationId, isInitiator, status, chat, setMessages]);

  // Host-side approval forwarding: a viewer tab can't resolve the live
  // `approval-requested` tool part (it lives in the host's in-memory
  // chat). The viewer broadcasts AGENT_APPROVE; the host (owner) applies
  // it to its own chat here.
  useEffect(() => {
    if (!conversationId) return;
    if (isViewer) return;
    const cid = conversationId;
    const onMessage = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as {
        type?: string;
        conversationId?: string;
        toolCallId?: string;
        approved?: boolean;
      };
      if (
        m.type === RUNTIME_MESSAGES.AGENT_APPROVE &&
        m.conversationId === cid &&
        typeof m.toolCallId === "string" &&
        typeof m.approved === "boolean"
      ) {
        void addToolApprovalResponse({ id: m.toolCallId, approved: m.approved });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [conversationId, isViewer, addToolApprovalResponse]);

  useEffect(() => {
    const listener = (message: {
      type: string;
      conversationId?: string;
    }) => {
      if (message.type !== "AGENT_STOP") return;
      if (!isLoading) return;
      // Conversation-scoped: only act if the sender's cid matches
      // ours. Backward-compat for legacy senders that omit cid (e.g.
      // the content-script in-page Stop overlay, which doesn't know
      // the cid of the run working its tab): treat missing cid as a
      // broadcast and fall through to the legacy behavior so the
      // in-page Stop still aborts the active run for single-conversation
      // users. With multiple parallel conversations, the renderer-side
      // viewer Stop button (ChatView.tsx) DOES include the cid, so
      // cross-conversation crosstalk is prevented for that path.
      if (
        message.conversationId != null &&
        message.conversationId !== conversationId
      ) {
        return;
      }
      stop();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [isLoading, stop, conversationId]);

  const latestUndoRef = useRef<{ undo: AgentTabsClosedUndo; toastId: string | number } | null>(null);

  useEffect(() => {
    const listener = (message: { type: string; conversationId?: string; undo?: AgentTabsClosedUndo }) => {
      if (
        message.type === "AGENT_TABS_CLOSED" &&
        message.conversationId === conversationId &&
        message.undo &&
        message.undo.tabs.length > 0
      ) {
        const undo = message.undo;
        const builtAction = buildUndoAction(undo);
        const toastId = toast(formatClosedToast(undo), {
          action: {
            label: builtAction.label,
            onClick: () => {
              builtAction.onClick();
              // Clear synchronously so a fast ⌘Z before the dismiss
              // callback fires can't trigger a second OVERLAY_UNDO.
              latestUndoRef.current = null;
            },
          },
          onDismiss: () => {
            if (latestUndoRef.current?.toastId === toastId) latestUndoRef.current = null;
          },
          onAutoClose: () => {
            if (latestUndoRef.current?.toastId === toastId) latestUndoRef.current = null;
          },
        });
        latestUndoRef.current = { undo, toastId };
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey && !e.altKey)) return;
      const current = latestUndoRef.current;
      if (!current) return;
      // Don't hijack undo while the user is editing text (e.g. the chat composer).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      performUndo(current.undo);
      toast.dismiss(current.toastId);
      latestUndoRef.current = null;
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [conversationId]);

  // Detect context overflow errors and auto-trigger compaction.
  //
  // Thrash detection is done inside `runCompaction` itself
  // (`shouldDebounceCompaction`), which reads the latest completed
  // compaction event from the visible message list. So no per-state
  // counter to track here — if a compaction just completed and another
  // overflow fires, the debounce will skip the retry.
  useEffect(() => {
    if (!error || !conversationId) return;
    const msg = error.message?.toLowerCase() ?? "";
    const isOverflow =
      msg.includes("context") ||
      msg.includes("token") ||
      msg.includes("maximum") ||
      msg.includes("too long") ||
      msg.includes("exceeds");
    if (isOverflow && messages.length >= MIN_MESSAGES_FOR_COMPACTION) {
      clearError();
      runCompaction(conversationId, messages, { auto: true, overflow: true });
    }
  }, [error, conversationId, messages, clearError, runCompaction]);

  /**
   * Auto-flush queued user messages once the agent's current turn ends.
   *
   * Triggers whenever the status, queue, or compaction flag changes
   * such that a flush is now safe:
   *
   *  - status is back to `ready` (not `streaming` or `submitted`)
   *  - queue is non-empty for the current conversation
   *  - no compaction is in flight (compaction sends its own synthetic
   *    "Continue..." message; we don't want to race it)
   *  - the last assistant message isn't sitting in `approval-requested`
   *    state — that's the user's turn to respond, not ours
   *  - there's no unhandled error (existing error banner takes over)
   *
   * Cross-panel coordination is handled by `queueDb.claimHead`'s lock
   * row. If a sibling panel claimed first, `claimHead` returns null
   * and this one sits out the round.
   *
   * The flushed message is persisted to chat-db with the same shape as
   * `handleSubmit` produces, then dispatched via `sendMessage`. The
   * usual `healPendingTools` runs first so a denied/aborted tool call
   * in the prior turn doesn't trip `MissingToolResultsError` on send.
   */
  useEffect(() => {
    if (!conversationId) return;
    if (status !== "ready") return;
    if (isCompacting) return;
    if (error) return;
    if (queue.length === 0) return;
    // Pause if the user is actively editing a queued item — draining
    // it would invalidate their pending edit. The watcher will retry
    // when `setQueueEditing(null)` is called and any of the existing
    // deps change (typically the queue itself, after the edit lands).
    if (queueEditingIdRef.current !== null) return;

    // Defer to user when an approval is pending. Detects via the same
    // shape used elsewhere — last assistant message containing a tool
    // part in `approval-requested` state.
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) {
      const hasPendingApproval = lastAssistant.parts.some(
        (p) =>
          (p.type === "dynamic-tool" ||
            (typeof p.type === "string" && p.type.startsWith("tool-"))) &&
          (p as { state?: string }).state === "approval-requested",
      );
      if (hasPendingApproval) return;
    }

    let cancelled = false;
    (async () => {
      let claimed: QueuedMessage | null = null;
      try {
        // Defensive: probe the SW agent host for an active run and,
        // if one exists, wait for it to terminate before draining the
        // queue. `probeAgentRunAwaitIdle` stays attached as a subscriber
        // and resolves only after the run actually emits its terminal
        // event (or after `waitMs` as a safety cap), closing the race
        // where the SW's run-termination sequence hasn't released the
        // registry handle yet.
        const swStillRunning = await probeAgentRunAwaitIdle(conversationId);
        if (cancelled) return;
        if (swStillRunning) {
          // Promote to viewer mode while the SW finishes its turn so
          // the UI shows "agent is busy" (Stop button, spinner) for
          // the duration. Without this, the side panel would show the
          // composer as idle while the SW continues running tools —
          // user can't tell anything is happening and may try to send
          // again, which also diverts into the queue and stacks up.
          //
          // Critical: `isViewer` is listed in this effect's dep array,
          // so when the SW finishes and the STREAM_DONE handler flips
          // viewer mode off, this effect re-runs and drains the queue.
          // Without that dep, a SW run longer than `waitMs` (5s) would
          // leave the queue permanently stuck — the watcher would
          // never re-trigger until some unrelated dep (status, queue,
          // messages) happens to change.
          if (!isViewerRef.current) setIsViewer(true);
          // Seed the watchdog clock when we enter viewer mode through a
          // path that isn't a STREAM_PARTS receive (which seeds it
          // naturally at line 1409). Without this, a quiet phase of the
          // SW run (long tool call, no chunks for >30s) would let the
          // viewer watchdog (line 1497) decide the session is stale
          // immediately and tear down viewer mode prematurely.
          lastMirrorActivityRef.current = Date.now();
          return;
        }

        claimed = await queueDb.claimHead(conversationId);
        if (!claimed) return;
        if (cancelled) {
          await queueDb.releaseHead(conversationId, claimed.id, false).catch(() => {});
          return;
        }

        // Heal any stranded tool calls before adding the queued message.
        // Same rationale as in handleSubmit.
        const { healed, healedMessages } = healPendingTools(
          messages,
          "Superseded by queued user message",
        );
        if (healedMessages.length > 0) {
          setMessages(healed);
          await persistHealedMessages(conversationId, healedMessages);
        }

        const persistedText = claimed.text + claimed.attachmentBlock;
        const mentionParts = buildMentionContextParts(claimed.mentionContext);
        const fileParts: SerializedUIPart[] = claimed.visionFiles.map((vf) => ({
          type: "file" as const,
          mediaType: vf.mediaType,
          url: vf.url,
        }));
        // Same id-alignment requirement as `handleSubmit`/`confirmEdit`:
        // generate the id once and use it for both the chatDb row and
        // the SDK's in-memory message so a later `confirmEdit` can find
        // the row by id. See the comment in `handleSubmit` for the full
        // failure mode.
        const userMessageId = generateId();
        await chatDb.saveMessage({
          id: userMessageId,
          conversationId,
          role: "user",
          content: persistedText,
          parts: [
            ...(persistedText
              ? [{ type: "text" as const, text: persistedText }]
              : []),
            ...fileParts,
            ...mentionParts,
          ],
          createdAt: Date.now(),
        });

        // Hydrate the conversation's tab handle map for the next agent
        // run. Tools that need a target tab read explicit `tab` args, so
        // there's no implicit "host tab" to pin any more.
        setAgentContext(conversationId);

        const agentPrefix = formatAgentMentionPrefix(
          parseAgentMentions(claimed.text),
          new Set(listAgents().map((a) => a.slug)),
        );
        const text =
          agentPrefix + claimed.text + claimed.attachmentBlock;
        const files = claimed.visionFiles.map((vf) => ({
          type: "file" as const,
          mediaType: vf.mediaType,
          url: vf.url,
        }));
        const sendParts: AgentMessage["parts"] = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...files,
          ...mentionParts,
        ];
        sendMessage({
          id: userMessageId,
          role: "user",
          parts: sendParts,
        });

        await queueDb.releaseHead(conversationId, claimed.id, true);
      } catch (err) {
        console.error("[queue] flush failed:", err);
        if (claimed) {
          // Keep the queued item; release the lock so the next attempt
          // can retry rather than hanging indefinitely.
          await queueDb.releaseHead(conversationId, claimed.id, false).catch(
            () => {},
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    status,
    conversationId,
    queue,
    isCompacting,
    error,
    messages,
    setMessages,
    sendMessage,
    // `isViewer` is load-bearing here: when the SW finishes a long
    // run, the STREAM_DONE handler flips viewer mode off. That
    // transition is what re-arms this effect to drain the queue.
    // Without `isViewer` in deps, queued messages would sit forever
    // any time the SW run outlasted `probeAgentRunAwaitIdle`'s waitMs.
    isViewer,
  ]);

  // Track what triggered the load effect to avoid overwriting in-memory approval state.
  //
  // We key the "already loaded" guard off the Chat INSTANCE identity (not a
  // stringified conversationId/transport pair). Reason: the module-level
  // `chatInstances` cache can be evicted (see onFinish setTimeout above). If
  // a later transport rebuild causes `useMemo` to mint a brand-new empty Chat
  // for the same conversationId, a string-based loadKey would still match the
  // previous value, the early-return below would fire, and the UI would be
  // left with an empty messages array while the header still shows the title.
  // Keying off `chat` identity guarantees we reload from DB whenever a new
  // Chat instance is selected.
  const prevLoadedChatRef = useRef<Chat<AgentMessage> | null>(null);

  // Reset per-conversation tracking when the active conversation changes.
  // Token tracking lives in agent-transport as a module global; without
  // this reset, switching conversations carries the previous
  // conversation's last-step token count into needsCompaction() until the
  // next streaming step overwrites it.
  //
  // Compaction state itself is no longer cached in React state — the
  // renderer derives it from the messages array via `findCompactionEvents`,
  // and `runCompaction` reads from the DB on demand for thrash debounce.
  useEffect(() => {
    resetTokenTracking();
  }, [conversationId]);

  // Load messages from DB when conversation changes
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      prevLoadedChatRef.current = null;
      return;
    }
    // If chat is already streaming (background), don't reload from DB
    if (status === "streaming" || status === "submitted") return;
    // Skip only when we've already loaded messages into *this exact* Chat
    // instance. Status changes don't re-enter this branch because `chat`
    // identity is stable across them, which preserves in-memory
    // approval-requested state.
    if (prevLoadedChatRef.current === chat) return;
    prevLoadedChatRef.current = chat;

    chatDb.getMessages(conversationId).then(async (initialMsgs) => {
      // Self-heal: drop a trailing empty assistant message left over
      // from an `onFinish`-on-error save that pre-dates the
      // `hasMeaningfulContent` gate above. Without this, the user sees
      // a bare regenerate-icon bubble after refreshing a chat that
      // errored. After the delete, the conversation reads as if the
      // user's last message is unanswered, so a manual retry / continue
      // (or the host's queue-flush, once a run is started) takes over.
      let msgs = initialMsgs;
      const lastDb = msgs[msgs.length - 1];
      if (
        lastDb &&
        lastDb.role === "assistant" &&
        !hasMeaningfulContent(lastDb.parts)
      ) {
        await chatDb.deleteMessagesFrom(conversationId, lastDb.id);
        msgs = msgs.slice(0, -1);
      }

      if (msgs.length > 0) {
        const uiMsgs = msgs.map(dbMessageToUIMessage);
        setMessages(uiMsgs);
        // Hydrate the agent context (and tab handle map) for any
        // subsequent action — retry, regenerate, approve a pending tool
        // call. Doing it unconditionally on conversation load means
        // resolveTabHandle has live state regardless of which path the
        // user takes after opening the conversation.
        setAgentContext(conversationId);

        // First-turn dispatch for a freshly-created conversation.
        //
        // The side panel / ChatView `handleSubmit` (and the home
        // LandingPage) create a conversation, persist the first user
        // message, and switch here via `onNewConversation` WITHOUT
        // calling sendMessage directly — they rely on this effect to
        // dispatch the first turn once the new chat instance mounts.
        //
        // We gate that dispatch on the `pending-first-turn` marker so it
        // fires ONLY for a just-created conversation, never as an
        // unconditional auto-resume of a trailing unanswered user message.
        // Auto-resuming on load caused every open context (home tab, side
        // panel, popup, duplicate home tabs) to independently restart the
        // same task. A stale tab reopening an existing conversation has no
        // marker, so it won't auto-start; the user resumes manually via
        // the composer (or the error banner's Continue/Retry). If two
        // contexts somehow both observe the marker, the ownership claim in
        // the status effect ensures only one actually drives the run.
        const lastMsg = uiMsgs[uiMsgs.length - 1];
        if (lastMsg.role === "user" && transport) {
          const cid = conversationId;
          const pending = await hasPendingFirstTurn(cid);
          if (pending && conversationIdRef.current === cid) {
            await clearPendingFirstTurn(cid);

            // Resolve deferred mention context in place. Sends that defer
            // resolution (LandingPage, so the hero navigates instantly)
            // persist clean text with no data-mention-context part; we
            // resolve tabs + summarize referenced chats here — with the
            // message already on screen and its chip shimmering — then attach
            // the model-only data part before dispatching. Messages that were
            // resolved at send time (side panel) already carry the part and
            // skip this entirely.
            const alreadyResolved = lastMsg.parts.some(
              (pt) => pt.type === "data-mention-context",
            );
            const msgText = lastMsg.parts
              .filter((pt) => pt.type === "text")
              .map((pt) => (pt as { text: string }).text)
              .join("");
            const tabMentions = extractTabMentionsFromText(msgText);
            const needsResolve =
              !alreadyResolved &&
              (tabMentions.length > 0 ||
                extractChatMentionsFromText(msgText).length > 0);

            if (needsResolve) {
              const ac = new AbortController();
              mentionResolveAbortRef.current = ac;
              setResolvingMessageId(lastMsg.id);
              try {
                const mentionContext =
                  (await formatMentionContext(tabMentions)) +
                  (await formatChatMentionContext(msgText, {
                    signal: ac.signal,
                  }));
                if (!ac.signal.aborted) {
                  const mentionParts = buildMentionContextParts(mentionContext);
                  if (mentionParts.length > 0) {
                    setMessages(
                      uiMsgs.map((m) =>
                        m.id === lastMsg.id
                          ? { ...m, parts: [...m.parts, ...mentionParts] }
                          : m,
                      ),
                    );
                    const row = (await chatDb.getMessages(cid)).find(
                      (r) => r.id === lastMsg.id,
                    );
                    if (row) {
                      await chatDb.saveMessage({
                        ...row,
                        parts: [...row.parts, ...mentionParts],
                      });
                    }
                  }
                }
              } catch {
                // Resolution failed — fall through and dispatch without the
                // extra context (the message itself still sends).
              } finally {
                mentionResolveAbortRef.current = null;
              }
              // Stop pressed during resolution: cancel the turn entirely.
              if (ac.signal.aborted) {
                setResolvingMessageId(null);
                return;
              }
            }

            if (conversationIdRef.current !== cid) {
              setResolvingMessageId(null);
              return;
            }
            // Dispatch BEFORE clearing the shimmer so `isLoading` stays true
            // across the handoff (no idle flicker between resolve and stream).
            sendMessage();
            setResolvingMessageId(null);
          }
        }
      }
    });
  }, [conversationId, chat, transport, setMessages, sendMessage, status]);

  const handleSubmit = useCallback(
    async (
      mentions: TabMentionAttrs[] = [],
      attachments: Attachment[] = [],
    ) => {
      // Read the latest editor text via the ref, not the closure's
      // `input` — see `inputRef` for why (compact-then-send runs this
      // after an await boundary). Shadowing keeps the rest of the body
      // unchanged.
      const input = inputRef.current;
      if (!input.trim() && attachments.length === 0) return;
      if (!isConfigured) return;

      // Defensive: probe the SW agent host directly to see if there's
      // an active run for this conversation. The local `isLoading`
      // signal (used by ChatInput to route Enter to queue vs submit)
      // is derived from `useChat.status` and `isViewer`; both can
      // desync from the SW's truth — in particular, this renderer may
      // have just mounted while the SW is mid-run, so `status` reads
      // `"ready"` and `isViewer` is still false until the first
      // STREAM_PARTS broadcast arrives. If we submit anyway, the port
      // router silently folds our new START into a viewer attach
      // (per `port-router.ts:96-106`), DROPPING the new message
      // payload — the user's text vanishes from chat-db entirely.
      // Probe synchronously here and divert to the queue path if the
      // SW has a live run.
      //
      // Only runs when we already have a conversationId — for a brand
      // new conversation there can't be an active run.
      const existingConvId = conversationIdRef.current;
      if (existingConvId) {
        const swHasActiveRun = await probeAgentRun(existingConvId);
        if (swHasActiveRun) {
          // Promote this surface to viewer mode immediately so the UI
          // reflects "agent is busy" (Stop button, spinner) without
          // waiting for the first STREAM_PARTS broadcast — otherwise
          // the composer would flash back to the Send button between
          // the user clicking Send and the SW publishing its next
          // snapshot, which is jarring and invites a second Send
          // click that would also divert into the queue.
          if (!isViewerRef.current) setIsViewer(true);
          // Seed the viewer watchdog clock — same rationale as the
          // matching site in the queue auto-flush effect. We are
          // entering viewer mode without a STREAM_PARTS receive, so
          // `lastMirrorActivityRef` would otherwise be 0 and the
          // 30s-idle watchdog (line 1497) would tear viewer mode down
          // on its next tick during a quiet phase of the SW run.
          lastMirrorActivityRef.current = Date.now();
          // Divert to the queue. `queueMessage` reads the editor via
          // the same `input` state we just checked, so we don't need
          // to rebuild the payload — but `queueMessage` is defined
          // BELOW `handleSubmit` in this file, so we call it via the
          // ref captured during render to avoid an init-order foot-gun.
          await queueMessageRef.current?.(mentions, attachments);
          return;
        }
      }

      // Heal any stranded tool calls in the existing history before
      // we append a new user message:
      //
      //   - `approval-requested` parts get `output-denied` so they
      //     produce a tool-result instead of leaving an unmatched
      //     tool_use.
      //   - `input-available` parts get `output-error` for the same
      //     reason — without this, sending the new user message would
      //     trip the AI SDK's `MissingToolResultsError` validation.
      //
      // Why we mutate state directly instead of `addToolApprovalResponse`
      // or `addToolOutput`:
      //
      // - `addToolApprovalResponse({ approved: false })` moves the part
      //   to `approval-responded` with `approval.approved = false`. The
      //   SDK's agent loop only processes denials via
      //   `collectToolApprovals`, which ONLY looks at the last message.
      //   Once we push a user message on top, the denial is invisible
      //   and the call goes out with an Anthropic tool_use lacking a
      //   matching tool_result → API rejects.
      //
      // - `addToolOutput({ state: "output-error" })` produces a real
      //   tool-result, but its Zod schema requires
      //   `approval.approved === true` for that state. The stale
      //   `{ id }` approval fails validation and the message falls
      //   through to the data-part schema → "Type must start with data-".
      //
      // - The correct target for approvals is `output-denied` with
      //   `approval.approved = false`, and the correct target for an
      //   un-resolved input-available is plain `output-error`. Neither
      //   has a public API that writes them client-side, so
      //   `healPendingTools` mutates via `setMessages` and we persist
      //   the change to chatDb to survive reloads.
      //
      // Read `messagesRef.current` (not the closure `messages`): in the
      // compact-then-send flow this runs after `compactNow()` appended the
      // compaction marker + summary, and the `handleSubmit` instance held
      // by ChatView's onCommand closure predates that. Healing against the
      // stale closure would `setMessages` a marker-less array and drop the
      // just-created compaction event. See `messagesRef`.
      const { healed, healedMessages } = healPendingTools(
        messagesRef.current,
        "Superseded by new user message",
      );
      if (healedMessages.length > 0) {
        setMessages(healed);
        await persistHealedMessages(
          conversationIdRef.current,
          healedMessages,
        );
      }

      let convId = conversationIdRef.current;
      let isNew = false;
      if (!convId) {
        convId = generateId();
        isNew = true;
        const truncatedTitle = input.trim().slice(0, 100) || "Image";
        // Capture the renderer's window id so the SW-hosted agent loop
        // can scope its tab queries (system-prompt awareness, listTabs)
        // to THIS window even when the user later focuses a different
        // Chrome window. See Conversation.originWindowId.
        let originWindowId: number | null = null;
        try {
          const w = await chrome.windows.getCurrent();
          originWindowId = typeof w?.id === "number" ? w.id : null;
        } catch {
          // Non-extension realm or no current window — leave null.
        }
        await chatDb.createConversation({
          id: convId,
          title: truncatedTitle,
          spaceId,
          ...(editingArtifactId ? { editingArtifactId } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          originWindowId,
          // Apply the mode the user selected in the composer before
          // sending the first message (see useAgentChat.initialMode JSDoc).
          // Falls back to "ask" implicitly when undefined.
          ...(initialModeRef.current !== undefined && {
            mode: initialModeRef.current,
          }),
        });

        const titleConvId = convId;
        const titleMessage = input.trim();
        // `agentSettings.agentModel` is a compound "<providerId>:<modelId>" key
        // (legacy stored values may be a flat model id). Both segments must be
        // split before lookup: comparing the whole compound key against a bare
        // `m.id` never matches, which silently skipped title generation for
        // every normally-selected model. Mirrors LandingPage's resolution.
        const [providerIdStr, ...modelIdParts] =
          agentSettings.agentModel.split(":");
        const hasProvider = modelIdParts.length > 0;
        const normalizedModelId = hasProvider
          ? modelIdParts.join(":")
          : agentSettings.agentModel;
        const provider = registryProviders.find((p) =>
          hasProvider
            ? p.id === providerIdStr
            : p.models.some((m) => m.id === normalizedModelId),
        );
        if (provider && titleMessage) {
          const config = settings.providerConfigs[provider.id] ?? {};
          window.dispatchEvent(new CustomEvent("chat-title-generating", { detail: { id: titleConvId } }));
          chrome.runtime.sendMessage({
            type: "GENERATE_CHAT_TITLE",
            providerId: provider.id,
            config,
            modelId: normalizedModelId,
            userMessage: titleMessage,
          }).then((res: any) => {
            if (res?.title) {
              chatDb.updateConversation(titleConvId, { title: res.title });
            }
            window.dispatchEvent(new CustomEvent("chat-title-updated", { detail: { id: titleConvId, title: res?.title } }));
          }).catch(() => {
            window.dispatchEvent(new CustomEvent("chat-title-updated", { detail: { id: titleConvId } }));
          });
        }
      }

      const baseText = input.trim();
      // Optimistic echo while mention context resolves. When the message
      // references a past chat, resolving it may run a (possibly slow)
      // summarization (see formatChatMentionContext). Render a temporary user
      // bubble with the mention chip shimmering so the send doesn't look
      // frozen during that wait. Purely visual — the real turn still
      // dispatches below, unchanged.
      const hasChatMention = extractChatMentionsFromText(baseText).length > 0;
      if (hasChatMention) {
        setPendingMention({ text: baseText });
        setInput("");
      }
      const mentionContext =
        (await formatMentionContext(mentions)) +
        (await formatChatMentionContext(baseText));

      let attachmentBlock: string;
      let visionFiles: { mediaType: string; url: string }[];
      try {
        ({ block: attachmentBlock, visionFiles } = await formatAttachments(
          convId,
          attachments,
          agentSettings.agentModel,
        ));
      } catch (e) {
        // Spec §7: stop on first failure, surface error, leave input intact
        // so the user can retry after removing the offending attachment.
        toast.error(
          `Failed to save attachments: ${(e as Error).message ?? String(e)}`,
        );
        if (hasChatMention) {
          setPendingMention(null);
          setInput(baseText);
        }
        return;
      }

      // `text` is what the model sees; `persistedText` is what we store in
      // chat-db. The attachment block must persist so `UserMessage` can
      // re-render filename chips after a reload. Mention context (mentioned
      // tabs/chats) is NOT concatenated into `text` — it rides as a persisted
      // `data-mention-context` part that the transport substitutes into model
      // text, so the bubble stays clean with no UI-side stripping.
      // The agent-mention prefix is model-only (`@agent:<slug>` instructs the
      // parent's first tool call), so we keep it out of `persistedText`.
      const agentPrefix = formatAgentMentionPrefix(
        parseAgentMentions(baseText),
        new Set(listAgents().map((a) => a.slug)),
      );
      const text = agentPrefix + baseText + attachmentBlock;
      const persistedText = baseText + attachmentBlock;
      // Mention context (mentioned tabs/chats) rides as a persisted
      // data-mention-context part, not inline text: it stays out of the
      // rendered bubble and is substituted into model text by the transport
      // (see substituteMentionContextPart). Resolved above so the snapshot
      // reflects what the user saw at send time.
      const mentionParts = buildMentionContextParts(mentionContext);

      const fileParts: SerializedUIPart[] = visionFiles.map((vf) => ({
        type: "file" as const,
        mediaType: vf.mediaType,
        url: vf.url,
      }));

      // Generate the message id once and use it for both the chatDb
      // row and the AI SDK's in-memory chat state. Without this, the
      // SDK auto-generates its own id on `sendMessage`, the two ids
      // diverge, and a later `confirmEdit` calling
      // `chatDb.deleteMessagesFrom(messageId)` (where `messageId` is
      // the SDK id) silently no-ops because no chatDb row matches —
      // leaving the entire post-edit tail in chat-db. After a refresh
      // the stale tail reappears alongside the new turn.
      // See `confirmEdit` below for the matching pattern.
      const userMessageId = generateId();

      await chatDb.saveMessage({
        id: userMessageId,
        conversationId: convId,
        role: "user",
        content: persistedText,
        parts: [
          ...(persistedText ? [{ type: "text" as const, text: persistedText }] : []),
          ...fileParts,
          ...mentionParts,
        ],
        createdAt: Date.now(),
      });

      setInput("");

      const files = visionFiles.map((vf) => ({
        type: "file" as const,
        mediaType: vf.mediaType,
        url: vf.url,
      }));

      // Compaction-aware message assembly now lives in the transport.
      // We just register the conversation context here so the agent's
      // tab-handle map is hydrated before tool calls run.
      // Bind the side panel's currently-shared active tab into the new
      // conversation BEFORE setAgentContext + onNewConversation. The
      // legend block re-reads `ownedLtids` from chatDb on every model
      // call, so awaiting the bind here guarantees the auto-resume
      // sendMessage triggered by the message-load effect (after
      // `onNewConversation`) sees the shared tab in the very first
      // turn. We also pin it as the target so tools default to it and
      // the legend marks it `[active]`.
      if (isNew) {
        await bindSharedTab(
          { conversationId: convId, tabId: getSharedTabId?.() ?? null },
          {
            send: (msg) => chrome.runtime.sendMessage(msg),
            setTargetTabId,
          },
        );
      }
      setAgentContext(convId);

      if (isNew) {
        // Mark the conversation as needing its first turn dispatched, then
        // switch to it. The message-load effect picks up the persisted user
        // message and dispatches sendMessage() for the new chat instance —
        // gated on this marker so only freshly-created conversations
        // auto-start (a stale tab reopening an existing conversation must
        // NOT). Cross-tab double-dispatch is prevented by the ownership
        // claim, not this marker.
        await markPendingFirstTurn(convId);
        setPendingMention(null);
        onNewConversation(convId);
      } else {
        // Construct a full `UIMessage` (id + role + parts) instead of
        // the `{ text, files }` shorthand so the SDK adopts our
        // `userMessageId` instead of generating its own. Mention context
        // rides as a `data-mention-context` part (model-only, injected by
        // the transport), so both stored and sent text stay clean — same
        // split as `confirmEdit`.
        const sendParts: AgentMessage["parts"] = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...files,
          ...mentionParts,
        ];
        sendMessage({
          id: userMessageId,
          role: "user",
          parts: sendParts,
        });
        setPendingMention(null);
      }
    },
    [input, isConfigured, spaceId, onNewConversation, sendMessage, agentSettings.agentModel, settings.providerConfigs, messages, setMessages, getSharedTabId, editingArtifactId],
  );

  /**
   * Enqueue a user message instead of sending it. Mirrors handleSubmit's
   * preflight (conversation creation if needed, mention/attachment
   * snapshotting) but persists into queue-db rather than calling
   * sendMessage. The auto-flush watcher below picks it up once the
   * agent's current turn ends.
   *
   * Snapshot semantics: `formatMentionContext` is awaited NOW (so tab
   * snapshots reflect what the user saw at queue time) and
   * `formatAttachments` is also awaited NOW (so attachment bytes hit
   * OPFS immediately, tied to convId).
   */
  const queueMessage = useCallback(
    async (
      mentions: TabMentionAttrs[] = [],
      attachments: Attachment[] = [],
    ) => {
      if (!input.trim() && attachments.length === 0) return;
      if (!isConfigured) return;

      let convId = conversationIdRef.current;
      let isNew = false;
      if (!convId) {
        // Mirror handleSubmit's new-conversation branch. We still need a
        // convId to key the queue and the OPFS workspace.
        convId = generateId();
        isNew = true;
        const truncatedTitle = input.trim().slice(0, 100) || "Image";
        let originWindowId: number | null = null;
        try {
          const w = await chrome.windows.getCurrent();
          originWindowId = typeof w?.id === "number" ? w.id : null;
        } catch {
          // ignore
        }
        await chatDb.createConversation({
          id: convId,
          title: truncatedTitle,
          spaceId,
          ...(editingArtifactId ? { editingArtifactId } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          originWindowId,
          // Apply the mode the user selected in the composer before
          // queuing/sending (see useAgentChat.initialMode JSDoc).
          ...(initialModeRef.current !== undefined && {
            mode: initialModeRef.current,
          }),
        });
      }

      const baseText = input.trim();
      // Resolving a chat mention's context can run a slow summary. Clear the
      // composer and show an optimistic placeholder row in the queue right
      // away so enqueue doesn't look frozen while it resolves; the real
      // queued item replaces it once the snapshot is captured below.
      const hasChatMention = extractChatMentionsFromText(baseText).length > 0;
      if (hasChatMention) {
        setEnqueuingMention({ text: baseText });
        setInput("");
      }
      const mentionContext =
        (await formatMentionContext(mentions)) +
        (await formatChatMentionContext(baseText));

      let attachmentBlock = "";
      let visionFiles: { mediaType: string; url: string }[] = [];
      try {
        ({ block: attachmentBlock, visionFiles } = await formatAttachments(
          convId,
          attachments,
          agentSettings.agentModel,
        ));
      } catch (e) {
        toast.error(
          `Failed to save attachments: ${(e as Error).message ?? String(e)}`,
        );
        if (hasChatMention) {
          setEnqueuingMention(null);
          setInput(baseText);
        }
        return;
      }

      await queueDb.enqueue({
        id: generateId(),
        conversationId: convId,
        text: baseText,
        mentionContext,
        attachmentBlock,
        visionFiles,
        createdAt: Date.now(),
      });

      setEnqueuingMention(null);
      setInput("");

      if (isNew) {
        // Mirror handleSubmit: bind the side panel's currently-shared
        // tab into the new conversation so the queued message's
        // eventual flush sees it in the legend on the first turn.
        await bindSharedTab(
          { conversationId: convId, tabId: getSharedTabId?.() ?? null },
          {
            send: (msg) => chrome.runtime.sendMessage(msg),
            setTargetTabId,
          },
        );
        // Make the brand-new conversation visible so its queue panel
        // and (eventually) the flush-side user message render in the
        // correct chat view.
        onNewConversation(convId);
      }
    },
    [input, isConfigured, spaceId, agentSettings.agentModel, onNewConversation, getSharedTabId, editingArtifactId],
  );

  // Forward reference so `handleSubmit` (defined above) can divert to
  // queueMessage when the SW probe reports an active run. Initialised
  // here, after `queueMessage`'s `useCallback` returns.
  queueMessageRef.current = queueMessage;

  const removeQueued = useCallback(async (id: string) => {
    await queueDb.remove(id);
  }, []);

  const updateQueued = useCallback(
    async (
      id: string,
      patch: Partial<
        Pick<
          QueuedMessage,
          "text" | "mentionContext" | "attachmentBlock" | "visionFiles"
        >
      >,
    ) => {
      await queueDb.update(id, patch);
    },
    [],
  );

  const clearQueue = useCallback(async () => {
    const cid = conversationIdRef.current;
    if (!cid) return;
    await queueDb.clear(cid);
  }, []);

  const handleNew = useCallback(() => {
    onNewConversation("");
    setMessages([]);
    setInput("");
  }, [onNewConversation, setMessages]);

  /**
   * Retry after an error — CONTINUE the partial assistant turn in place.
   *
   * Unlike a destructive regenerate, this keeps every part already produced
   * and resumes generation into the SAME assistant message, without inserting
   * any synthetic user message.
   *
   * How it works: after a mid-stream error the partial assistant message is
   * the tail of `messages` (onFinish persisted it). The AI SDK's
   * `createStreamingUIMessageState` seeds the streaming state from a trailing
   * assistant message (same id + existing parts) and merges new chunks into
   * it, so a bare `sendMessage()` (no new message) continues that turn. The
   * transport ships the partial assistant as the trailing message and
   * Anthropic continues it (assistant prefill).
   *
   * We first heal any stranded tool calls (a dangling
   * `input-available`/`approval-requested` part would otherwise throw
   * `MissingToolResultsError` on convert). If the agent errored before any
   * assistant content (tail is the user prompt), `sendMessage()` simply
   * answers that prompt — so one path covers both cases.
   */
  const handleRetry = useCallback(async () => {
    clearError();
    const { healed, healedMessages } = healPendingTools(
      messages,
      "Superseded by retry",
    );
    if (healedMessages.length > 0) {
      setMessages(healed);
      await persistHealedMessages(conversationId, healedMessages);
    }
    sendMessage();
  }, [messages, conversationId, sendMessage, clearError, setMessages]);

  /**
   * Retry from a specific USER message: discard every turn after it and
   * re-run the response from that prompt. Used by the per-user-message Retry
   * action (the caller confirms first). Follows the heal→delete→regenerate
   * sequence, but the regenerate target is the user message itself so the SDK
   * keeps the prompt and drops everything after.
   */
  const handleRetryFromUser = useCallback(
    async (userMessageId: string) => {
      clearError();
      const idx = messages.findIndex((m) => m.id === userMessageId);
      if (idx === -1) return;

      // Heal stranded tool calls in the surviving prefix (everything after
      // `idx` is about to be deleted by regenerate's slice anyway).
      const survivors = messages.slice(0, idx + 1);
      const { healed, healedMessages } = healPendingTools(
        survivors,
        "Superseded by retry from user message",
      );
      if (healedMessages.length > 0) {
        setMessages([...healed, ...messages.slice(idx + 1)]);
        await persistHealedMessages(conversationId, healedMessages);
      }

      // Keep chatDb in sync with the in-memory slice the SDK will take:
      // delete the first message AFTER the user message (and everything past
      // it, by createdAt).
      const next = messages[idx + 1];
      if (conversationId && next) {
        await chatDb.deleteMessagesFrom(conversationId, next.id);
      }
      regenerate({ messageId: userMessageId });
    },
    [messages, conversationId, regenerate, clearError, setMessages],
  );

  const confirmEdit = useCallback(
    async (
      messageId: string,
      mentions: TabMentionAttrs[] = [],
      attachments: Attachment[] = [],
    ) => {
      if (!input.trim() && attachments.length === 0) return;
      if (!isConfigured) return;
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // Heal any stranded tool calls that will survive the edit slice
      // (everything at/after `idx` is about to be deleted anyway). See
      // the long note in `handleSubmit`.
      const survivors = messages.slice(0, idx);
      const { healed, healedMessages } = healPendingTools(
        survivors,
        "Superseded by edited user message",
      );
      if (healedMessages.length > 0) {
        setMessages(healed);
        await persistHealedMessages(conversationId, healedMessages);
      }

      setMessages(survivors);
      if (conversationId) {
        await chatDb.deleteMessagesFrom(conversationId, messageId);
      }

      const baseText = input.trim();
      // Optimistic echo while a chat mention's context resolves (possibly a
      // slow summary). The edited turn's real bubble is dispatched below via
      // sendMessage; until then, show the shimmering placeholder in its place
      // so the edit doesn't look frozen. Mirrors handleSubmit.
      const hasChatMention = extractChatMentionsFromText(baseText).length > 0;
      if (hasChatMention) setPendingMention({ text: baseText });
      const mentionContext =
        (await formatMentionContext(mentions)) +
        (await formatChatMentionContext(baseText));

      let attachmentBlock: string;
      let visionFiles: { mediaType: string; url: string }[];
      try {
        // TODO(workspace-cleanup): edits write attachments to OPFS but
        // never remove files that were attached to the prior version of
        // this message. Repeated edits can leak duplicates into the
        // conversation workspace (with `(2)`, `(3)`, ... suffixes from
        // OPFS.uniquePath). Acceptable for v1; address with a real diff
        // against the prior persisted parts when we add workspace cleanup.
        ({ block: attachmentBlock, visionFiles } = await formatAttachments(
          conversationId!,
          attachments,
          agentSettings.agentModel,
        ));
      } catch (e) {
        toast.error(
          `Failed to save attachments: ${(e as Error).message ?? String(e)}`,
        );
        setPendingMention(null);
        return;
      }

      // See `handleSubmit` for rationale on the text/persistedText split.
      const agentPrefix = formatAgentMentionPrefix(
        parseAgentMentions(baseText),
        new Set(listAgents().map((a) => a.slug)),
      );
      const text = agentPrefix + baseText + attachmentBlock;
      const persistedText = baseText + attachmentBlock;
      // Mention context (mentioned tabs/chats) rides as a persisted
      // data-mention-context part, not inline text: it stays out of the
      // rendered bubble and is substituted into model text by the transport
      // (see substituteMentionContextPart). Resolved above so the snapshot
      // reflects what the user saw at send time.
      const mentionParts = buildMentionContextParts(mentionContext);

      const fileParts: SerializedUIPart[] = visionFiles.map((vf) => ({
        type: "file" as const,
        mediaType: vf.mediaType,
        url: vf.url,
      }));

      const newMessageId = generateId();
      await chatDb.saveMessage({
        id: newMessageId,
        conversationId: conversationId!,
        role: "user",
        content: persistedText,
        parts: [
          ...(persistedText ? [{ type: "text" as const, text: persistedText }] : []),
          ...fileParts,
          ...mentionParts,
        ],
        createdAt: Date.now(),
      });

      setInput("");

      // Construct a full message payload (id + role + parts) instead of the
      // `{ text, files, messageId }` shorthand. Passing `messageId` to the AI
      // SDK's `sendMessage` instructs it to *replace* an existing message in
      // state with that id — but we just sliced the original out via
      // `setMessages(messages.slice(0, idx))`, and `newMessageId` is brand new,
      // so the SDK throws `message with id <newMessageId> not found`. Pushing
      // it as a new message keeps state aligned with chatDb (both keyed by
      // `newMessageId`) and lets the UI re-render the edited bubble immediately
      // without a chat switch.
      const sendParts: AgentMessage["parts"] = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...visionFiles.map((vf) => ({
          type: "file" as const,
          mediaType: vf.mediaType,
          url: vf.url,
        })),
        ...mentionParts,
      ];

      sendMessage({
        id: newMessageId,
        role: "user",
        parts: sendParts,
      });
      setPendingMention(null);
    },
    [input, isConfigured, messages, setMessages, conversationId, sendMessage, agentSettings.agentModel],
  );

  const setAgentModel = useCallback(
    (modelId: string) => {
      const updated = { ...agentSettings, agentModel: modelId };
      setAgentSettings(updated);
      storage.setAgentSettings(updated);

      const cloudProviders: CloudProvider[] = ["openai", "anthropic", "google"];
      for (const providerId of cloudProviders) {
        const provider = registryProviders.find((p) => p.id === providerId);
        if (provider && provider.models.some((m) => m.id === modelId) && providerId !== settings.cloudProvider) {
          const updatedSettings = { ...settings, cloudProvider: providerId };
          setSettings(updatedSettings);
          storage.setSettings(updatedSettings);
          break;
        }
      }
    },
    [agentSettings, settings],
  );

  const setThinkingSettings = useCallback(
    (enabled: boolean, config?: ThinkingConfig) => {
      const updated = { ...agentSettings, thinkingEnabled: enabled, thinkingConfig: config };
      setAgentSettings(updated);
      storage.setAgentSettings(updated);
    },
    [agentSettings, setAgentSettings],
  );

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    storage.setSettings(next);
  }, [settings]);

  // Viewer-aware tool approval. When this context is a viewer (another
  // tab owns the live run), the local `addToolApprovalResponse` would
  // operate on a stale, non-driving chat. Instead forward the decision
  // to the host via AGENT_APPROVE, which applies it to the live part.
  const approveToolCall = useCallback(
    (opts: { id: string; approved: boolean }) => {
      if (isViewerRef.current && conversationIdRef.current) {
        try {
          chrome.runtime
            ?.sendMessage?.({
              type: RUNTIME_MESSAGES.AGENT_APPROVE,
              conversationId: conversationIdRef.current,
              toolCallId: opts.id,
              approved: opts.approved,
            })
            ?.catch?.(() => {});
        } catch {
          /* non-extension context; ignore */
        }
        return;
      }
      return addToolApprovalResponse(opts);
    },
    [addToolApprovalResponse],
  );

  return {
    messages,
    input,
    setInput,
    isLoading,
    isStreaming,
    isViewer,
    isCompacting,
    pendingMention,
    enqueuingMention,
    resolvingMessageId,
    isConfigured,
    // True once the chat transport has finished building. The transport is
    // constructed synchronously (RemoteChatTransport), so on first render it
    // is null and the underlying Chat has no transport — sending then would
    // fall through to the AI SDK's default `api/chat` endpoint (ERR_FILE_NOT_FOUND
    // in the extension). Headless/background runs auto-send and must wait for
    // this before calling handleSubmit.
    isReady: transport !== null,
    hasVisionSupport,
    settings,
    updateSettings,
    agentSettings,
    setAgentModel,
    setThinkingSettings,
    handleSubmit,
    compactNow,
    handleNew,
    handleRetry,
    handleRetryFromUser,
    confirmEdit,
    addToolApprovalResponse,
    approveToolCall,
    stop,
    error,
    clearError,
    // Message queue: see `queueMessage` JSDoc and the auto-flush watcher.
    queue,
    queueMessage,
    removeQueued,
    updateQueued,
    clearQueue,
    /**
     * Tell the hook a queued message is being edited (or stop telling
     * it). Pauses the auto-flush watcher while set so the row the
     * user is editing isn't drained out from under them. Pass `null`
     * to resume normal flushing.
     */
    setQueueEditing,
  };
}
