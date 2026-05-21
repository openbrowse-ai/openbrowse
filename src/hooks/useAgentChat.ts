import { chatDb } from "@/lib/chat-db";
import { createAgentTransport } from "@/lib/chat-transport";
import {
  resetAgentIndicator,
  setAgentSpaceColor,
  setAgentContext,
  needsCompaction,
  resetTokenTracking,
  getCurrentModelDef,
  setCurrentModelDef,
} from "@/lib/agent/agent-transport";
import { setAgentActive, setAgentInactive } from "@/lib/active-agents";
import {
  pruneMessages as pruneMessageParts,
  selectTail,
  buildCompactionPrompt,
  getCompactionSystemPrompt,
  prepareMessagesForSummarization,
  findCompactionEvents,
  shouldDebounceCompaction,
  MIN_MESSAGES_FOR_COMPACTION,
} from "@/lib/agent/compaction";
import type { CompactionPart } from "@/lib/types";
import {
  type TabMentionAttrs,
  type ImagePreview,
  formatMentionContext,
} from "@/components/chat/ChatInput";
import { DEFAULT_AGENT_SETTINGS, DEFAULT_SETTINGS } from "@/lib/constants";
import { getMcpRegistry } from "@/lib/mcp";
import { storage } from "@/lib/storage";
import { providers as registryProviders } from "@/registry/providers";
import type {
  AgentSettings,
  CloudProvider,
  SerializedToolPart,
  SerializedUIPart,
  Settings,
  ThinkingConfig,
} from "@/lib/types";
import { Chat, useChat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import type {
  ChatTransport,
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  SourceUrlUIPart,
  StepStartUIPart,
  TextUIPart,
  UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AgentMessage = UIMessage;

interface UseAgentChatOptions {
  conversationId: string | null;
  spaceId: string | null;
  onNewConversation: (id: string) => void;
  /**
   * Override for the host tab id used by the agent's implicit
   * first-tool-call binding. When `undefined`, useAgentChat resolves the
   * panel's host tab from the active tab in the current window. Pass an
   * explicit value (or `null`) when the panel is rendered in a popover and
   * `currentWindow` would resolve to the popup itself.
   */
  hostTabIdOverride?: number | null;
}

function generateId() {
  return crypto.randomUUID();
}

function serializeParts(parts: AgentMessage["parts"]): SerializedUIPart[] {
  return parts.flatMap((part): SerializedUIPart[] => {
    switch (part.type) {
      case "text":
        return [{ type: "text", text: part.text }];
      case "reasoning":
        return [{ type: "reasoning", text: part.text }];
      case "file":
        return [{ type: "file", mediaType: part.mediaType, url: part.url }];
      case "source-url":
        return [
          {
            type: "source-url",
            sourceId: part.sourceId,
            url: part.url,
            title: part.title,
          },
        ];
      case "step-start":
        return [{ type: "step-start" }];
      case "dynamic-tool":
        return [
          {
            type: "dynamic-tool",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            state: part.state,
            input: part.input,
            output: "output" in part ? part.output : undefined,
            errorText: "errorText" in part ? part.errorText : undefined,
            approval: "approval" in part ? part.approval : undefined,
          },
        ];
      default: {
        const p = part as Record<string, unknown>;
        if (
          typeof part.type === "string" &&
          part.type.startsWith("tool-") &&
          "toolCallId" in p &&
          "state" in p &&
          "input" in p
        ) {
          return [
            {
              type: "dynamic-tool",
              toolName: part.type.slice(5),
              toolCallId: p.toolCallId as string,
              state: p.state as string,
              input: p.input,
              output: "output" in p ? p.output : undefined,
              errorText: "errorText" in p ? (p.errorText as string) : undefined,
            },
          ];
        }
        return [];
      }
    }
  });
}

function extractTextContent(parts: SerializedUIPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function deserializePart(
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
  if (existing) return existing.chat;

  const chat = new Chat<AgentMessage>({
    transport: transport ?? undefined,
    generateId,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: async ({ message }) => {
      const parts = serializeParts(message.parts);
      await chatDb.saveMessage({
        id: message.id,
        conversationId,
        role: "assistant",
        content: extractTextContent(parts),
        parts,
        createdAt: Date.now(),
      });
      await chatDb.updateConversation(conversationId, { updatedAt: Date.now() });
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
  hostTabIdOverride,
}: UseAgentChatOptions) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(
    DEFAULT_AGENT_SETTINGS,
  );
  const [input, setInput] = useState("");

  // Latest host tab override; the resolver below reads it via ref so
  // resolveHostTabId() doesn't need to be a dep of every effect that uses it.
  const hostTabOverrideRef = useRef<number | null | undefined>(hostTabIdOverride);
  hostTabOverrideRef.current = hostTabIdOverride;

  const resolveHostTabId = useCallback(async (): Promise<number | null> => {
    const override = hostTabOverrideRef.current;
    if (override !== undefined) return override;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    } catch {
      return null;
    }
  }, []);
  const [isCompacting, setIsCompacting] = useState(false);
  // AbortController for the in-flight compaction summary call. The chat's
  // `stop()` cancels the agent stream; this cancels the summarization
  // LLM call separately.
  const compactionAbortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  useEffect(() => {
    storage.getSettings().then(setSettings);
    storage.getAgentSettings().then(setAgentSettings);
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local") {
        if (changes.settings) storage.getSettings().then(setSettings);
        if (changes["agent-settings"])
          storage.getAgentSettings().then(setAgentSettings);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

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

  const isConfigured = useMemo(() => {
    if (!agentSettings.agentModel) return false;
    const provider = registryProviders.find((p) =>
      p.models.some((m) => m.id === agentSettings.agentModel)
    );
    if (!provider) return false;
    if (provider.setup === "byok") {
      const config = settings.providerConfigs[provider.id] ?? {};
      const requiredFields = provider.configSchema?.filter((f) => f.required) ?? [];
      return requiredFields.every((f) => !!config[f.key]);
    }
    if (provider.setup === "web-llm") {
      return settings.downloadedModels.includes(agentSettings.agentModel);
    }
    return true;
  }, [agentSettings.agentModel, settings.providerConfigs, settings.downloadedModels]);

  useEffect(() => {
    if (!agentSettings.agentModel) return;
    import("@/registry/providers").then(({ providers }) => {
      for (const provider of providers) {
        const model = provider.models.find((m) => m.id === agentSettings.agentModel);
        if (model) {
          setCurrentModelDef(model);
          return;
        }
      }
      setCurrentModelDef(undefined);
    });
  }, [agentSettings.agentModel]);

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
        agentSettings.thinkingEnabled
          ? { enabled: true, config: agentSettings.thinkingConfig }
          : undefined,
      );
      if (!cancelled) setTransport(t);
    })();
    return () => { cancelled = true; };
  }, [settings, agentSettings.agentModel, agentSettings.thinkingEnabled, agentSettings.thinkingConfig, spaceId, mcpVersion]);

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
      opts?: { auto?: boolean; overflow?: boolean },
    ) => {
      if (msgs.length < MIN_MESSAGES_FOR_COMPACTION) return;

      // Time-based debounce thrash detection. If we just compacted within
      // COMPACTION_DEBOUNCE_MS, don't compact again — covers the case
      // where the produced summary itself overflows and would otherwise
      // loop. Reads directly from the visible message list, so the UI
      // and the runtime agree on what counts.
      const dbMessages = await chatDb.getMessages(convId);
      const events = findCompactionEvents(dbMessages);
      if (shouldDebounceCompaction(events)) return;

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
        const { headMessages, tailStartId } = selectTail(pruned, modelDef);
        if (!tailStartId || headMessages.length === 0) return;

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
        const provider = providers.find((p) =>
          p.models.some((m) => m.id === compactionModelId),
        );
        if (!provider) return;

        const config =
          settingsForCompaction.providerConfigs[provider.id] ?? {};
        const compactionModel = provider.createLanguageModel(
          config,
          compactionModelId,
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

        // Auto-continue: send a synthetic user message asking the agent
        // to resume. Manual /compact (follow-up) would skip this. The
        // wording matches OpenCode's continue prompt.
        if (auto) {
          // Auto-deny any pending approvals that would otherwise leave
          // the conversation in an invalid tool_use-without-tool_result
          // state when we send the continue message. Mirrors the same
          // logic in handleSubmit.
          const hasPending = msgs.some((m) =>
            m.parts.some(
              (p) =>
                ((p as Record<string, unknown>).type === "dynamic-tool" ||
                  (typeof (p as Record<string, unknown>).type === "string" &&
                    ((p as Record<string, unknown>).type as string).startsWith(
                      "tool-",
                    ))) &&
                (p as Record<string, unknown>).state === "approval-requested",
            ),
          );
          if (hasPending) {
            const reason = "Superseded by auto-compaction continue";
            setMessages((prev) =>
              prev.map((msg) => ({
                ...msg,
                parts: msg.parts.map((part) => {
                  const p = part as Record<string, unknown>;
                  const isTool =
                    p.type === "dynamic-tool" ||
                    (typeof p.type === "string" &&
                      (p.type as string).startsWith("tool-"));
                  if (isTool && p.state === "approval-requested" && p.approval) {
                    const approval = p.approval as { id: string };
                    return {
                      ...part,
                      state: "output-denied",
                      approval: {
                        id: approval.id,
                        approved: false,
                        reason,
                      },
                    } as typeof part;
                  }
                  return part;
                }),
              })),
            );
          }

          const continueText = overflow
            ? "The previous request exceeded the context window. The conversation was compacted. Continue where you left off, or ask for clarification if unsure how to proceed."
            : "Continue where you left off, or ask for clarification if unsure how to proceed.";
          sendMessage({ text: continueText });
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
      } finally {
        if (compactionAbortRef.current === abortController) {
          compactionAbortRef.current = null;
        }
        setIsCompacting(false);
      }
    },
    [sendMessage, setMessages],
  );

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
    return () => {
      if (wasStreamingRef.current && conversationId) {
        setAgentInactive(conversationId);
      }
    };
  }, [conversationId]);

  useEffect(() => {
    const listener = (message: { type: string }) => {
      if (message.type === "AGENT_STOP" && isLoading) {
        stop();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [isLoading, stop]);

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

    chatDb.getMessages(conversationId).then((msgs) => {
      if (msgs.length > 0) {
        const uiMsgs = msgs.map(dbMessageToUIMessage);
        setMessages(uiMsgs);
        const lastMsg = uiMsgs[uiMsgs.length - 1];
        if (lastMsg.role === "user" && transport) {
          // Bind the panel's host tab so the agent has a working target on
          // its first tab tool call. Compaction-aware message assembly now
          // lives in the transport, so we no longer prefilter the message
          // list here — the wrapper reads chatDb compaction state at
          // send-time.
          resolveHostTabId().then((hostTabId) => {
            setAgentContext(conversationId, hostTabId);
          });
          sendMessage();
        }
      }
    });
  }, [conversationId, chat, transport, setMessages, sendMessage, status]);

  const handleSubmit = useCallback(
    async (mentions: TabMentionAttrs[] = [], images: ImagePreview[] = []) => {
      if (!input.trim() && images.length === 0) return;
      if (!isConfigured) return;

      // Auto-deny any approval requests still pending when the user sends a
      // new message.
      //
      // Why we mutate state directly instead of using addToolApprovalResponse
      // or addToolOutput:
      //
      // - `addToolApprovalResponse({ approved: false })` moves the part to
      //   state `approval-responded` with `approval.approved = false`. But
      //   the SDK's agent loop only processes denials via `collectToolApprovals`
      //   which ONLY looks at the last message. Once we push a user message
      //   on top, the denial is invisible and the call goes out with an
      //   Anthropic tool_use lacking a matching tool_result → API rejects.
      //
      // - `addToolOutput({ state: "output-error" })` produces a real tool-result,
      //   but its Zod schema requires `approval.approved === true` for that
      //   state. The stale `{ id }` approval fails validation and the message
      //   falls through to the data-part schema → "Type must start with data-".
      //
      // - The correct target is `state: "output-denied"` with
      //   `approval.approved = false`, but no public API writes that state
      //   client-side. So we mutate via setMessages.
      const hasPending = messages.some((m) =>
        m.parts.some(
          (p) =>
            ((p as Record<string, unknown>).type === "dynamic-tool" ||
              (typeof (p as Record<string, unknown>).type === "string" &&
                ((p as Record<string, unknown>).type as string).startsWith("tool-"))) &&
            (p as Record<string, unknown>).state === "approval-requested",
        ),
      );
      if (hasPending) {
        const reason = "Superseded by new user message";
        setMessages(
          messages.map((msg) => ({
            ...msg,
            parts: msg.parts.map((part) => {
              const p = part as Record<string, unknown>;
              const isTool =
                p.type === "dynamic-tool" ||
                (typeof p.type === "string" && (p.type as string).startsWith("tool-"));
              if (isTool && p.state === "approval-requested" && p.approval) {
                const approval = p.approval as { id: string };
                return {
                  ...part,
                  state: "output-denied",
                  approval: { id: approval.id, approved: false, reason },
                } as typeof part;
              }
              return part;
            }),
          })),
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
      const text = baseText + mentionContext;

      const fileParts: SerializedUIPart[] = images.map((img) => ({
        type: "file" as const,
        mediaType: img.file.type,
        url: img.dataUrl,
      }));

      await chatDb.saveMessage({
        id: generateId(),
        conversationId: convId,
        role: "user",
        content: baseText,
        parts: [
          ...(baseText ? [{ type: "text" as const, text: baseText }] : []),
          ...fileParts,
        ],
        createdAt: Date.now(),
      });

      setInput("");

      const files = images.map((img) => ({
        type: "file" as const,
        mediaType: img.file.type,
        url: img.dataUrl,
      }));

      // Compaction-aware message assembly now lives in the transport. Here
      // we just bind the host tab so tool calls have a default target.
      resolveHostTabId().then((hostTabId) => {
        setAgentContext(convId, hostTabId);
      });

      if (isNew) {
        // Set conversation ID first — the effect will load the user message
        // from DB and call sendMessage on the correct chat instance.
        onNewConversation(convId);
      } else {
        if (text) {
          sendMessage({ text, files: files.length > 0 ? files : undefined });
        } else {
          sendMessage({ files });
        }
      }
    },
    [input, isConfigured, spaceId, onNewConversation, sendMessage, agentSettings.agentModel, settings.providerConfigs, messages, setMessages],
  );

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

  const confirmEdit = useCallback(
    async (messageId: string, mentions: TabMentionAttrs[] = [], images: ImagePreview[] = []) => {
      if (!input.trim() && images.length === 0) return;
      if (!isConfigured) return;
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // Auto-deny any pending approval requests — see note in handleSubmit.
      const hasPending = messages.some((m) =>
        m.parts.some(
          (p) =>
            ((p as Record<string, unknown>).type === "dynamic-tool" ||
              (typeof (p as Record<string, unknown>).type === "string" &&
                ((p as Record<string, unknown>).type as string).startsWith("tool-"))) &&
            (p as Record<string, unknown>).state === "approval-requested",
        ),
      );
      if (hasPending) {
        const reason = "Superseded by edited user message";
        setMessages(
          messages.map((msg) => ({
            ...msg,
            parts: msg.parts.map((part) => {
              const p = part as Record<string, unknown>;
              const isTool =
                p.type === "dynamic-tool" ||
                (typeof p.type === "string" && (p.type as string).startsWith("tool-"));
              if (isTool && p.state === "approval-requested" && p.approval) {
                const approval = p.approval as { id: string };
                return {
                  ...part,
                  state: "output-denied",
                  approval: { id: approval.id, approved: false, reason },
                } as typeof part;
              }
              return part;
            }),
          })),
        );
      }

      setMessages(messages.slice(0, idx));
      if (conversationId) {
        await chatDb.deleteMessagesFrom(conversationId, messageId);
      }

      const baseText = input.trim();
      const mentionContext = await formatMentionContext(mentions);
      const text = baseText + mentionContext;

      const fileParts: SerializedUIPart[] = images.map((img) => ({
        type: "file" as const,
        mediaType: img.file.type,
        url: img.dataUrl,
      }));

      const newMessageId = generateId();
      await chatDb.saveMessage({
        id: newMessageId,
        conversationId: conversationId!,
        role: "user",
        content: baseText,
        parts: [
          ...(baseText ? [{ type: "text" as const, text: baseText }] : []),
          ...fileParts,
        ],
        createdAt: Date.now(),
      });

      setInput("");

      const files = images.map((img) => ({
        type: "file" as const,
        mediaType: img.file.type,
        url: img.dataUrl,
      }));

      if (text) {
        sendMessage({ text, files: files.length > 0 ? files : undefined, messageId: newMessageId });
      } else {
        sendMessage({ files, messageId: newMessageId });
      }
    },
    [input, isConfigured, messages, setMessages, conversationId, sendMessage],
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

  return {
    messages,
    input,
    setInput,
    isLoading,
    isStreaming,
    isCompacting,
    isConfigured,
    settings,
    agentSettings,
    setAgentModel,
    setThinkingSettings,
    handleSubmit,
    handleNew,
    handleRegenerate,
    confirmEdit,
    addToolApprovalResponse,
    stop,
    error,
    clearError,
  };
}
