import { chatDb } from "@/lib/chat-db";
import { createAgentTransport } from "@/lib/chat-transport";
import { formatAttachments } from "@/lib/chat/format-attachments";
import { queueDb, subscribeQueueChange } from "@/lib/queue-db";
import {
  resetAgentIndicator,
  setAgentSpaceColor,
  setAgentContext,
  needsCompaction,
  resetTokenTracking,
  getCurrentModelDef,
} from "@/lib/agent/agent-transport";
import { setTargetTabId } from "@/lib/agent/active-tab";
import { healPendingTools } from "@/lib/agent/heal-pending-tools";
import { bindSharedTab } from "@/lib/agent/bind-shared-tab";
import { setAgentActive, setAgentInactive } from "@/lib/active-agents";
import {
  pruneMessages as pruneMessageParts,
  selectTail,
  selectTailForManual,
  resolveCompactionModel,
  buildCompactionPrompt,
  getCompactionSystemPrompt,
  prepareMessagesForSummarization,
  findCompactionEvents,
  shouldDebounceCompaction,
  MIN_MESSAGES_FOR_COMPACTION,
} from "@/lib/agent/compaction";
import {
  type TabMentionAttrs,
  type Attachment,
  formatMentionContext,
} from "@/components/chat/ChatInput";
import { listAgents } from "@/lib/agent/subagents/registry";
import { finalizeOrphanedChildrenForHeals } from "@/lib/agent/subagents/heal-orphan-children";
import {
  formatAgentMentionPrefix,
  parseAgentMentions,
} from "@/lib/chat/format-agent-mention";
import {
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
  QueuedMessage,
  SerializedToolPart,
  SerializedUIPart,
  Settings,
  ThinkingConfig,
  AgentUIMessage,
  CompactionPart,
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
    case "data-completion-check-rejection":
      // Round-trip the rejection block so concerns are visible after a
      // reload. The data shape matches the AgentDataParts registration,
      // so the `as never` cast is a TS artifact (the SDK widens
      // `data-${string}` types to `unknown`-data variants).
      return {
        type: "data-completion-check-rejection",
        data: p.data,
      } as never;
    case "dynamic-tool":
      return deserializeToolPart(p);
    default:
      return null;
  }
}

function deserializeToolPart(p: SerializedToolPart): DynamicToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: p.toolName,
    toolCallId: p.toolCallId,
  };
  if (p.state === "output-available") {
    return { ...base, state: "output-available", input: p.input, output: p.output };
  }
  if (p.state === "output-error") {
    return { ...base, state: "output-error", input: p.input, errorText: p.errorText ?? "" };
  }
  if (p.state === "approval-requested" && p.approval) {
    return { ...base, state: "approval-requested", input: p.input, approval: { id: p.approval.id } } as DynamicToolUIPart;
  }
  if (p.state === "approval-responded" && p.approval) {
    return { ...base, state: "approval-responded", input: p.input, approval: p.approval as { id: string; approved: boolean; reason?: string } } as DynamicToolUIPart;
  }
  return { ...base, state: "input-available", input: p.input };
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

      // Skip persisting an "empty turn" — fired when the agent errored
      // before producing any content. Saving an empty assistant
      // message would leave a bare regenerate-icon bubble in the
      // conversation after a refresh (the in-memory error banner
      // doesn't survive reloads). Partial content (mid-stream errors,
      // user aborts) still persists because at least one meaningful
      // part exists by then.
      if (hasMeaningfulContent(parts)) {
        await chatDb.saveMessage({
          id: message.id,
          conversationId,
          role: "assistant",
          content: extractTextContent(parts),
          parts,
          createdAt: Date.now(),
        });
        await chatDb.updateConversation(conversationId, {
          updatedAt: Date.now(),
        });
      }
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

  const [isCompacting, setIsCompacting] = useState(false);
  // AbortController for the in-flight compaction summary call. The chat's
  // `stop()` cancels the agent stream; this cancels the summarization
  // LLM call separately.
  const compactionAbortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

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

  useEffect(() => {
    if (!spaceId) {
      setAgentSpaceColor(null);
      return;
    }
    storage.getSpaces().then((spaces) => {
      const space = spaces.find((s) => s.id === spaceId);
      setAgentSpaceColor(space?.colors?.[0] ?? null);
    });
  }, [spaceId]);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let spaceName: string | null = null;
      if (spaceId) {
        const spaces = await storage.getSpaces();
        spaceName = spaces.find((s) => s.id === spaceId)?.name ?? null;
      }
      const t = await createAgentTransport(
        settings,
        agentSettings.agentModel,
        spaceId,
        spaceName,
        conversationId,
        agentSettings.thinkingEnabled
          ? { enabled: true, config: agentSettings.thinkingConfig }
          : undefined,
        headless,
      );
      if (!cancelled) setTransport(t);
    })();
    return () => { cancelled = true; };
  }, [settings, agentSettings.agentModel, agentSettings.thinkingEnabled, agentSettings.thinkingConfig, spaceId, mcpVersion, headless?.autoApprove]);

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

  // Wrap the chat's stop() so it also aborts any in-flight compaction
  // summarization call. Without this, clicking Stop while a summary is
  // generating would silently let the LLM call continue and write a
  // compaction event into the chat after the user thought they had
  // cancelled.
  const stop = useCallback(() => {
    compactionAbortRef.current?.abort();
    chatStop();
  }, [chatStop]);

  const isLoading = status === "submitted" || status === "streaming";
  const isStreaming = status === "streaming";
  const wasStreamingRef = useRef(false);

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
    if (status === "streaming" || status === "submitted") {
      wasStreamingRef.current = true;
      if (conversationId) setAgentActive(conversationId);
    } else if (wasStreamingRef.current) {
      wasStreamingRef.current = false;
      resetAgentIndicator();
      if (conversationId) setAgentInactive(conversationId);

      // Check if compaction is needed after response completes. This
      // covers both true inter-turn compaction and mid-stream compaction
      // (where `stopWhen` in agent-transport caused the agent loop to
      // exit early at a step boundary because tokens crossed the
      // threshold). Either way, status flips out of streaming and we
      // land here.
      if (conversationId && needsCompaction() && messages.length >= MIN_MESSAGES_FOR_COMPACTION) {
        runCompaction(conversationId, messages, { auto: true });
      }
    }
  }, [status, conversationId, messages, runCompaction]);

  useEffect(() => {
    const listener = (message: { type: string }) => {
      if (message.type === "AGENT_STOP" && isLoading) {
        stop();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [isLoading, stop]);

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
  const isFlushingRef = useRef(false);
  useEffect(() => {
    if (!conversationId) return;
    if (status !== "ready") return;
    if (isCompacting) return;
    if (error) return;
    if (queue.length === 0) return;
    if (isFlushingRef.current) return;
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
      isFlushingRef.current = true;
      let claimed: QueuedMessage | null = null;
      try {
        claimed = await queueDb.claimHead(conversationId);
        if (!claimed || cancelled) return;

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
          agentPrefix + claimed.text + claimed.mentionContext + claimed.attachmentBlock;
        const files = claimed.visionFiles.map((vf) => ({
          type: "file" as const,
          mediaType: vf.mediaType,
          url: vf.url,
        }));
        const sendParts: AgentMessage["parts"] = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...files,
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
      } finally {
        isFlushingRef.current = false;
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
      // user's last message is unanswered, so the auto-resume branch
      // below (or a manual retry) takes over.
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
        // call, or auto-resume below. Doing it unconditionally on
        // conversation load means resolveTabHandle has live state regardless
        // of which path the user takes after opening the conversation.
        setAgentContext(conversationId);
        const lastMsg = uiMsgs[uiMsgs.length - 1];
        if (lastMsg.role === "user" && transport) {
          // Auto-resume: an unanswered user message at the tail of the
          // conversation. Compaction-aware message assembly lives in the
          // transport, so we no longer prefilter the message list here —
          // the wrapper reads chatDb compaction state at send-time.
          sendMessage();
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
        await chatDb.createConversation({
          id: convId,
          title: truncatedTitle,
          spaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const titleConvId = convId;
        const titleMessage = input.trim();
        const provider = registryProviders.find((p) =>
          p.models.some((m) => m.id === agentSettings.agentModel)
        );
        if (provider && titleMessage) {
          const config = settings.providerConfigs[provider.id] ?? {};
          window.dispatchEvent(new CustomEvent("chat-title-generating", { detail: { id: titleConvId } }));
          chrome.runtime.sendMessage({
            type: "GENERATE_CHAT_TITLE",
            providerId: provider.id,
            config,
            modelId: agentSettings.agentModel,
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
      const mentionContext = await formatMentionContext(mentions);

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
        return;
      }

      // `text` is what the model sees; `persistedText` is what we store in
      // chat-db. Mention context is intentionally model-only (keeps the
      // user's question clean in history); the attachment block, in
      // contrast, must persist so `UserMessage` can re-render filename
      // chips after a reload.
      // The agent-mention prefix is model-only too (`@agent:<slug>` instructs
      // the parent's first tool call), so we keep it out of `persistedText`.
      const agentPrefix = formatAgentMentionPrefix(
        parseAgentMentions(baseText),
        new Set(listAgents().map((a) => a.slug)),
      );
      const text = agentPrefix + baseText + mentionContext + attachmentBlock;
      const persistedText = baseText + attachmentBlock;

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
      // legend block re-reads `ownedTabIds` from chatDb on every model
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
        // Set conversation ID first — the effect will load the user message
        // from DB and call sendMessage on the correct chat instance.
        onNewConversation(convId);
      } else {
        // Construct a full `UIMessage` (id + role + parts) instead of
        // the `{ text, files }` shorthand so the SDK adopts our
        // `userMessageId` instead of generating its own. Note: `text`
        // (with mention context) goes to the model; chatDb stores
        // `persistedText` (without mention context) — same split as
        // `confirmEdit`.
        const sendParts: AgentMessage["parts"] = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...files,
        ];
        sendMessage({
          id: userMessageId,
          role: "user",
          parts: sendParts,
        });
      }
    },
    [input, isConfigured, spaceId, onNewConversation, sendMessage, agentSettings.agentModel, settings.providerConfigs, messages, setMessages, getSharedTabId],
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
        await chatDb.createConversation({
          id: convId,
          title: truncatedTitle,
          spaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      const baseText = input.trim();
      const mentionContext = await formatMentionContext(mentions);

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
    [input, isConfigured, spaceId, agentSettings.agentModel, onNewConversation, getSharedTabId],
  );

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

  const handleRegenerate = useCallback(
    async (messageId: string) => {
      if (conversationId) {
        await chatDb.deleteMessagesFrom(conversationId, messageId);
      }
      regenerate({ messageId });
    },
    [regenerate, conversationId],
  );

  /**
   * Retry the last attempt after an error. Used by the error banner's
   * Retry button.
   *
   * Two cases:
   *
   * - Last message is the user's prompt (the agent errored before
   *   producing any persistable assistant content — `onFinish`'s
   *   `hasMeaningfulContent` gate skipped saving). We just call
   *   `regenerate()` and the SDK runs a fresh attempt off that prompt.
   *
   * - Last message is a partial assistant message (mid-stream error
   *   that produced *some* content). Heal any stranded tool calls in
   *   the messages that will survive the regenerate slice, delete the
   *   partial assistant from chatDb to keep it in sync with the
   *   in-memory slice the SDK is about to take, then call
   *   `regenerate({ messageId })`.
   *
   * The bare `clearError(); handleSubmit()` previously wired here
   * silently no-op'd whenever the input field was empty (the common
   * case when clicking Retry).
   */
  const handleRetry = useCallback(async () => {
    clearError();
    const last = messages[messages.length - 1];
    if (!last) return;

    if (last.role === "assistant") {
      // Heal stranded tool calls in the surviving prefix so the
      // regenerated request doesn't trip MissingToolResultsError.
      const survivors = messages.slice(0, messages.length - 1);
      const { healed, healedMessages } = healPendingTools(
        survivors,
        "Superseded by retry",
      );
      if (healedMessages.length > 0) {
        setMessages([...healed, last]);
        await persistHealedMessages(conversationId, healedMessages);
      }
      if (conversationId) {
        await chatDb.deleteMessagesFrom(conversationId, last.id);
      }
      regenerate({ messageId: last.id });
      return;
    }

    // Last message is a user prompt — heal any prior stranded tool
    // calls and ask the SDK to generate an assistant response.
    const { healed, healedMessages } = healPendingTools(
      messages,
      "Superseded by retry",
    );
    if (healedMessages.length > 0) {
      setMessages(healed);
      await persistHealedMessages(conversationId, healedMessages);
    }
    regenerate();
  }, [messages, conversationId, regenerate, clearError, setMessages]);

  /**
   * Continue after an error, *keeping* the partial assistant output
   * already produced (unlike `handleRetry`, which discards the errored
   * turn and re-runs from the user prompt). Used by the error banner's
   * Continue button.
   *
   * There's no provider-agnostic "resume the exact stream" primitive
   * once a request has errored out (`resumeStream` only resumes a still
   * open server stream). So we resume the same way the auto-compaction
   * flow does: heal any stranded tool calls, then send a synthetic
   * "Continue where you left off" user message so the model picks up
   * with the prior partial output already in context. The synthetic
   * prompt is intentionally not persisted to chatDb.
   */
  const handleContinue = useCallback(async () => {
    clearError();
    const { healed, healedMessages } = healPendingTools(
      messages,
      "Superseded by continue",
    );
    if (healedMessages.length > 0) {
      setMessages(healed);
      await persistHealedMessages(conversationId, healedMessages);
    }
    sendMessage({
      id: generateId(),
      role: "user",
      parts: [
        {
          type: "text",
          text: "Continue where you left off, or ask for clarification if unsure how to proceed.",
        },
      ],
    });
  }, [messages, conversationId, sendMessage, clearError, setMessages]);

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
      const mentionContext = await formatMentionContext(mentions);

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
        return;
      }

      // See `handleSubmit` for rationale on the text/persistedText split.
      const agentPrefix = formatAgentMentionPrefix(
        parseAgentMentions(baseText),
        new Set(listAgents().map((a) => a.slug)),
      );
      const text = agentPrefix + baseText + mentionContext + attachmentBlock;
      const persistedText = baseText + attachmentBlock;

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
      ];

      sendMessage({
        id: newMessageId,
        role: "user",
        parts: sendParts,
      });
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

  return {
    messages,
    input,
    setInput,
    isLoading,
    isStreaming,
    isCompacting,
    isConfigured,
    // True once the chat transport has finished building. The transport is
    // constructed asynchronously (createAgentTransport), so on first render it
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
    handleRegenerate,
    handleRetry,
    handleContinue,
    confirmEdit,
    addToolApprovalResponse,
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
