import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  type Attachment,
  ChatInput,
  type ChatInputHandle,
  type TabMentionAttrs,
} from "@/components/chat/ChatInput";
import { ChatInputHalo } from "@/components/chat/ChatInputHalo";
import { FileViewerPanel } from "@/components/files/FileViewerPanel";
import { MemoryDeleteButton } from "@/components/memory/MemoryDeleteButton";
import { MemoryFileMeta } from "@/components/memory/MemoryFileMeta";
import { openSourceChat } from "@/components/memory/source-chat";
import {
  ColorPickerDialog,
  IconPickerButton,
} from "@/components/spaces/SpacePickers";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Wordmark } from "@/components/ui/wordmark";
import { useFilePanelWidth } from "@/hooks/useFilePanelWidth";
import { useProviders } from "@/hooks/useProviders";
import { useRecentTabs } from "@/hooks/useRecentTabs";
import { markPendingFirstTurn } from "@/lib/agent/pending-first-turn";
import { animatePanelResize } from "@/lib/animate-panel-resize";
import { chatDb } from "@/lib/chat-db";
import { formatAttachments } from "@/lib/chat/format-attachments";
import { DEFAULT_AGENT_SETTINGS, DEFAULT_SETTINGS } from "@/lib/constants";
import { memoryStore } from "@/lib/memory/store";
import { openSettingsTab } from "@/lib/open-settings";
import { storage } from "@/lib/storage";
import type {
  AgentSettings,
  ConversationMode,
  SerializedUIPart,
  Settings,
  Space,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { toast } from "sonner";
import {
  FILE_AUTO_WIDEN_PX,
  FILE_AUTO_WIDEN_THRESHOLD_PX,
  FILE_MIN_PX,
  TWEEN_MS,
} from "./file-panel-constants";
import { SpaceCustomization } from "./SpaceCustomization";
import { TabCard } from "./TabCard";

/** Tracks the Tailwind `xl` (min-width: 1280px) breakpoint. */
function useIsXl(): boolean {
  const [isXl, setIsXl] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 1280px)").matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = (e: MediaQueryListEvent) => setIsXl(e.matches);
    mq.addEventListener("change", onChange);
    setIsXl(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isXl;
}

interface LandingPageProps {
  space: Space | null;
  spaceId: string | null;
  tabCount: number;
  pinnedCount: number;
  onNewConversation: (id: string) => void;
  /**
   * Navigate to an existing conversation. Used by `[[chat:<id>]]` source links
   * in the rail's memory viewer, which point at the conversation a remembered
   * fact came from. Omitted → such links open/focus a home tab instead.
   */
  onOpenConversation?: (id: string) => void;
  /**
   * Pre-seeded value for the chat input (consumed once on mount). Used by the
   * "Try in chat" flow from settings.
   */
  initialInput?: string;
  /**
   * When true, focus the chat input the first time the window gains focus
   * after mount (one-shot). Used by the newtab surface to work around
   * Chrome's "omnibox keeps focus when you Cmd-T" behavior: the page can't
   * grab focus while the omnibox owns it, but the moment the user clicks
   * the page or hits Tab/Escape, `window` fires a focus event and we hand
   * it to the input. Subsequent tab-switches back do not steal focus.
   */
  refocusOnWindowFocus?: boolean;
}

const SUGGESTIONS = [
  "Summarize this page",
  "What's in my tabs?",
  "Find tabs about...",
];

export function LandingPage({
  space,
  spaceId,
  tabCount,
  pinnedCount,
  onNewConversation,
  onOpenConversation,
  initialInput,
  refocusOnWindowFocus = false,
}: LandingPageProps) {
  const recentTabs = useRecentTabs(space?.windowId ?? null);
  const [input, setInput] = useState(initialInput ?? "");
  // Bumped exactly once on first window-focus when refocusOnWindowFocus is
  // set; passed to ChatInput as `focusTrigger` to drive its existing
  // refocus effect. Stays null after the one shot, so subsequent
  // tab-switches back to this surface do not steal focus from whatever
  // the user is interacting with (sidebar, dropdowns, etc.).
  const [focusTrigger, setFocusTrigger] = useState<string | null>(null);

  useEffect(() => {
    if (!refocusOnWindowFocus) return;
    // If the document already has focus when this effect runs (cold cache,
    // slow first paint, or React StrictMode dev-mode double-mount where the
    // user provided focus between cycles), fire immediately and don't bother
    // attaching a listener that would never fire.
    if (document.hasFocus()) {
      setFocusTrigger(`win-focus-${Date.now()}`);
      return;
    }
    const handler = () => setFocusTrigger(`win-focus-${Date.now()}`);
    window.addEventListener("focus", handler, { once: true });
    return () => window.removeEventListener("focus", handler);
  }, [refocusOnWindowFocus]);
  /**
   * Workspace-relative path of a Space file the user clicked in the
   * right rail's `SpaceCustomization`. When non-null, the rail swaps
   * `SpaceCustomization` for `FileViewerPanel`. Closing the viewer
   * (`onClose`) resets to null and the customization rail returns.
   * Reset to null whenever the active space changes so the viewer
   * doesn't briefly point at a stale (possibly cross-space) path.
   */
  const [selectedSpaceFile, setSelectedSpaceFile] = useState<string | null>(
    null,
  );
  /**
   * Full OPFS path of a memory file the user clicked in the rail's memory
   * section. Distinct from `selectedSpaceFile` because memory lives under
   * `spaces/<id>/memory/` (or global `memory/`), not the workspace, so it
   * carries a full path rather than a workspace-relative one. Mutually
   * exclusive with `selectedSpaceFile` (selecting one clears the other).
   */
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setSelectedSpaceFile(null);
    setSelectedMemoryFile(null);
  }, [space?.id]);

  const handleSelectSpaceFile = useCallback((rel: string) => {
    setSelectedMemoryFile(null);
    setSelectedSpaceFile(rel);
  }, []);
  const handleSelectMemoryFile = useCallback((fullPath: string) => {
    setSelectedSpaceFile(null);
    setSelectedMemoryFile(fullPath);
  }, []);
  const handleMemoryWikiLink = useCallback(
    async (name: string) => {
      const path = await memoryStore.resolveVisiblePath(
        name,
        space?.id ?? null,
      );
      if (path) {
        setSelectedSpaceFile(null);
        setSelectedMemoryFile(path);
      }
    },
    [space?.id],
  );
  const handleMemoryChatLink = useCallback(
    (conversationId: string) => {
      void openSourceChat(conversationId, onOpenConversation);
    },
    [onOpenConversation],
  );

  // ── Resizable right-aside plumbing (mirrors RightRail) ────────────────────
  // The aside hosts either SpaceCustomization (fixed width) or the file viewer
  // (user-resizable, width shared with the chat rail via useFilePanelWidth).
  const isXl = useIsXl();
  const [fileWidthPx, setFileWidthPx] = useFilePanelWidth();
  const asidePanelRef = useRef<PanelImperativeHandle | null>(null);
  const inFileMode = selectedSpaceFile !== null || selectedMemoryFile !== null;
  const inFileModeRef = useRef(inFileMode);
  inFileModeRef.current = inFileMode;
  const fileWidthRef = useRef(fileWidthPx);
  fileWidthRef.current = fileWidthPx;
  const animatingRef = useRef(false);
  const cancelTweenRef = useRef<(() => void) | null>(null);
  const hasInitializedAsideRef = useRef(false);

  /** Fixed width for the customization view; matches the old `xl:w-96`. */
  const CUSTOMIZATION_WIDTH_PX = 384;

  // Initial defaultSize captured once at mount, as a percentage to dodge the
  // react-resizable-panels pixel-conversion mount bug (see RightRail).
  const [initialAsideSize] = useState<string>(() => {
    const targetPx = inFileMode
      ? fileWidthPx < FILE_AUTO_WIDEN_THRESHOLD_PX
        ? FILE_AUTO_WIDEN_PX
        : fileWidthPx
      : CUSTOMIZATION_WIDTH_PX;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const estimatedContainerWidth = Math.max(800, vw - 260);
    return `${(targetPx / estimatedContainerWidth) * 100}%`;
  });

  // Drive the aside width on mode change: file mode → persisted width (auto-
  // widened if narrow); customization → fixed width. Animated, like RightRail.
  useEffect(() => {
    if (!isXl) return;
    const handle = asidePanelRef.current;
    if (!handle) return;

    const target = inFileMode
      ? fileWidthRef.current < FILE_AUTO_WIDEN_THRESHOLD_PX
        ? FILE_AUTO_WIDEN_PX
        : fileWidthRef.current
      : CUSTOMIZATION_WIDTH_PX;

    if (!hasInitializedAsideRef.current) {
      hasInitializedAsideRef.current = true;
      const rafId = requestAnimationFrame(() => {
        asidePanelRef.current?.resize(`${target}px`);
      });
      return () => cancelAnimationFrame(rafId);
    }

    const fromPx = handle.getSize?.()?.inPixels ?? 0;
    if (Math.abs(fromPx - target) < 0.5) return;
    cancelTweenRef.current?.();
    cancelTweenRef.current = animatePanelResize(handle, fromPx, target, {
      durationMs: TWEEN_MS,
      flagRef: animatingRef,
    });
  }, [isXl, inFileMode]);

  useEffect(() => () => cancelTweenRef.current?.(), []);

  const maxAsidePx = `${Math.max(
    FILE_AUTO_WIDEN_PX,
    Math.min(
      900,
      Math.round(
        (typeof window !== "undefined" ? window.innerWidth : 1280) * 0.7,
      ),
    ),
  )}px`;

  // Seed the composer from a "seed-chat-input" event targeting a new chat
  // (conversationId === null) — used by the Scheduled view's "Create with
  // agent" action to insert "/schedule ".
  useEffect(() => {
    function onSeed(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { conversationId: string | null; text: string }
        | undefined;
      if (!detail || detail.conversationId != null) return;
      setInput(detail.text);
    }
    window.addEventListener("seed-chat-input", onSeed);
    return () => window.removeEventListener("seed-chat-input", onSeed);
  }, []);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(
    DEFAULT_AGENT_SETTINGS,
  );
  // Pre-conversation approval mode. The user can pick a mode in the
  // composer before sending the first message; we apply it when
  // creating the new conversation in `handleSubmit`. Default Ask.
  const [mode, setMode] = useState<ConversationMode>("ask");

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      storage.setSettings(next);
      return next;
    });
  }, []);

  const { providers } = useProviders();

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

  const providerModels = useMemo(() => {
    return providers
      .map((provider) => {
        let enabled = true;
        let availableModels = provider.models;

        if (provider.setup === "byok") {
          const config = settings.providerConfigs[provider.id] ?? {};
          const requiredFields =
            provider.configSchema?.filter((f) => f.required) ?? [];
          enabled = requiredFields.every((f) => !!config[f.key]);
          if (!enabled) return null;
        } else if (
          provider.setup === "web-llm" ||
          provider.setup === "browser-ai"
        ) {
          availableModels = provider.models.filter((m) =>
            settings.downloadedModels.includes(m.id),
          );
          enabled = availableModels.length > 0;
          if (!enabled) return null;
        }

        return {
          provider: provider.id,
          label: provider.name,
          models: availableModels,
          enabled,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }, [providers, settings.providerConfigs, settings.downloadedModels]);

  const isConfigured = useMemo(() => {
    if (!agentSettings.agentModel) return false;
    const [providerId, ...modelIdParts] = agentSettings.agentModel.split(":");
    const actualModelId =
      modelIdParts.length > 0
        ? modelIdParts.join(":")
        : agentSettings.agentModel;

    return providerModels.some((p) => {
      if (modelIdParts.length > 0 && p.provider !== providerId) return false;
      return p.models.some((m) => m.id === actualModelId);
    });
  }, [providerModels, agentSettings.agentModel]);

  // Auto-select a default model when none is set and at least one
  // provider is now configured. Without this, after the user enters
  // their first API key in Settings, the model-selector trigger renders
  // empty ("Select a model...") and `isConfigured` stays false, leaving
  // the chat input disabled until the user manually picks a model.
  //
  // Selection priority:
  //   1. The first user-favorited model that's actually available
  //   2. The first model marked `recommended` in any enabled provider
  //   3. The first model of the first enabled provider (last resort)
  useEffect(() => {
    if (agentSettings.agentModel) return;
    if (providerModels.length === 0) return;

    const isAvailable = (key: string) => {
      const [pid, ...rest] = key.split(":");
      const mid = rest.join(":");
      return providerModels.some(
        (g) => g.provider === pid && g.models.some((m) => m.id === mid),
      );
    };

    let pick: string | null = null;

    const favorite = settings.favoriteModels.find(isAvailable);
    if (favorite) pick = favorite;

    if (!pick) {
      for (const group of providerModels) {
        const rec = group.models.find((m) => m.recommended);
        if (rec) {
          pick = `${group.provider}:${rec.id}`;
          break;
        }
      }
    }

    if (!pick) {
      const group = providerModels[0];
      const model = group?.models[0];
      if (group && model) pick = `${group.provider}:${model.id}`;
    }

    if (pick) {
      const updated = { ...agentSettings, agentModel: pick };
      setAgentSettings(updated);
      void storage.setAgentSettings(updated);
    }
  }, [providerModels, agentSettings, settings.favoriteModels]);

  const handleSubmit = useCallback(
    async (_mentions: TabMentionAttrs[], attachments: Attachment[]) => {
      if (!input.trim() && attachments.length === 0) return;

      const convId = crypto.randomUUID();
      // Stamp the renderer's current window so the SW-hosted agent loop
      // can scope its tab queries (system-prompt awareness, listTabs,
      // navigate-no-handle) to THIS window. Mirrors the useAgentChat
      // handleSubmit branch (see useAgentChat.ts). Without this stamp,
      // LandingPage-created chats fall back to step 3 of the resolver
      // chain (space.windowId), which can be null after window
      // close/reopen between SW boots.
      let originWindowId: number | null = null;
      try {
        const w = await chrome.windows.getCurrent();
        originWindowId = typeof w?.id === "number" ? w.id : null;
      } catch {
        // Non-extension realm — leave null.
      }
      await chatDb.createConversation({
        id: convId,
        title: input.trim().slice(0, 100) || "Image",
        spaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        originWindowId,
        // Apply the user's pre-conversation mode selection.
        ...(mode !== "ask" && { mode }),
      });

      const baseText = input.trim();

      let attachmentBlock: string;
      let visionFiles: { mediaType: string; url: string }[];
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

      // Unlike useAgentChat.handleSubmit, LandingPage doesn't sendMessage
      // directly — the side panel / chat view mounts on onNewConversation,
      // reloads from chatDb, and dispatches the first turn. We persist clean
      // text and DEFER mention resolution to that first-turn dispatch (see
      // useAgentChat's message-load effect), so the hero navigates instantly
      // and any chat-mention summary is computed in the chat view with the
      // message's chip shimmering in place.
      const persistedText = baseText + attachmentBlock;

      const fileParts: SerializedUIPart[] = visionFiles.map((vf) => ({
        type: "file" as const,
        mediaType: vf.mediaType,
        url: vf.url,
      }));

      await chatDb.saveMessage({
        id: crypto.randomUUID(),
        conversationId: convId,
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

      // Generate a real chat title via the agent provider. The conversation
      // title currently holds the truncated raw user input; this upgrades it
      // to a short AI-generated label, matching useAgentChat's behavior for
      // side-panel-started chats. The async result also feeds the tab-group
      // labeler when navigate fires later.
      if (baseText) {
        const [providerIdStr, ...modelIdParts] =
          agentSettings.agentModel.split(":");
        const hasProvider = modelIdParts.length > 0;
        const targetProviderId = hasProvider ? providerIdStr : undefined;
        const normalizedModelId = hasProvider
          ? modelIdParts.join(":")
          : agentSettings.agentModel;

        const provider = providers.find((p) =>
          hasProvider
            ? p.id === targetProviderId
            : p.models.some((m) => m.id === normalizedModelId),
        );
        if (provider) {
          const config = settings.providerConfigs[provider.id] ?? {};
          window.dispatchEvent(
            new CustomEvent("chat-title-generating", {
              detail: { id: convId },
            }),
          );
          chrome.runtime
            .sendMessage({
              type: "GENERATE_CHAT_TITLE",
              providerId: provider.id,
              config,
              modelId: normalizedModelId,
              userMessage: baseText,
            })
            .then((res: { title?: string } | undefined) => {
              if (res?.title) {
                chatDb.updateConversation(convId, { title: res.title });
              }
              window.dispatchEvent(
                new CustomEvent("chat-title-updated", {
                  detail: { id: convId, title: res?.title },
                }),
              );
            })
            .catch(() => {
              window.dispatchEvent(
                new CustomEvent("chat-title-updated", {
                  detail: { id: convId },
                }),
              );
            });
        }
      }

      setInput("");
      // Mark the new conversation as needing its first turn dispatched.
      // LandingPage doesn't sendMessage directly — the side panel / chat
      // view mounts on `onNewConversation`, reloads from chatDb, and the
      // message-load effect dispatches the first turn, gated on this
      // marker (so it's a scoped first-turn dispatch, not auto-resume).
      await markPendingFirstTurn(convId);
      onNewConversation(convId);
    },
    [
      input,
      spaceId,
      onNewConversation,
      agentSettings.agentModel,
      settings.providerConfigs,
      mode,
    ],
  );

  const handleSuggestion = useCallback((text: string) => {
    setInput(text);
  }, []);

  const handleTabCardClick = useCallback(
    (tab: { title: string; url: string }) => {
      setInput((prev: string) =>
        prev ? `${prev} ${tab.title}` : `Tell me about ${tab.title}`,
      );
    },
    [],
  );

  // Page-level drag-and-drop. Dropping a file anywhere on the
  // LandingPage routes it into the hero composer's attachments,
  // *except* on the Files section in the right rail (which has its
  // own drop zone for adding to `spaces/<id>/workspace`). We hit-test
  // via `closest('[data-space-files-dropzone]')` and the SpaceFiles
  // section also calls `stopPropagation()` on its own handlers as a
  // belt-and-suspenders defense.
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [pageDragOver, setPageDragOver] = useState(false);
  const pageDragCounter = useRef(0);

  // Measured height of `SpaceLandingHeader` published as the CSS custom
  // property `--landing-header-h` on the LandingPage outer container.
  // The hero column uses it to compute `min-h: calc(100svh - var(...))`
  // on narrow viewports so the header + hero exactly fill the viewport
  // and the customization rail (Instructions / Files / …) sits below the
  // fold until the user scrolls.
  //
  // We measure with a ResizeObserver because the header height varies
  // slightly with theme/font and we want the calc to stay correct if a
  // future change adds (say) a deadline row to the header. The fallback
  // value (`7rem`) covers the initial paint before the observer fires
  // and the no-space branch where there's no header at all.
  const outerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const header = headerRef.current;
    if (!outer || !header) return;
    const apply = () => {
      outer.style.setProperty(
        "--landing-header-h",
        `${header.getBoundingClientRect().height}px`,
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    return () => ro.disconnect();
  }, [space?.id]);

  const isOverFilesDropzone = useCallback((target: EventTarget | null) => {
    return (
      target instanceof Element &&
      target.closest("[data-space-files-dropzone]") != null
    );
  }, []);

  const handlePageDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      if (isOverFilesDropzone(e.target)) return;
      e.preventDefault();
      pageDragCounter.current += 1;
      setPageDragOver(true);
    },
    [isOverFilesDropzone],
  );

  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      // Don't decrement if we never counted this drag (target was
      // inside the files dropzone).
      pageDragCounter.current -= 1;
      if (pageDragCounter.current <= 0) {
        pageDragCounter.current = 0;
        setPageDragOver(false);
      }
  }, []);

  const handlePageDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      if (isOverFilesDropzone(e.target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [isOverFilesDropzone],
  );

  const handlePageDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      if (isOverFilesDropzone(e.target)) return;
      e.preventDefault();
      pageDragCounter.current = 0;
      setPageDragOver(false);
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        chatInputRef.current?.addFiles(files);
        chatInputRef.current?.focus();
      }
    },
    [isOverFilesDropzone],
  );

  const pageDndHandlers = {
    onDragEnter: handlePageDragEnter,
    onDragLeave: handlePageDragLeave,
    onDragOver: handlePageDragOver,
    onDrop: handlePageDrop,
  };

  // Layout has two shapes:
  //
  // - No active space: a centered hero composer with `Wordmark`. The
  //   page is a single centered column, exactly today's behavior.
  // - Active space: hero composer (centered vertically) on the left;
  //   customization rail (General / Instructions / Files / Memory /
  //   Skills) on the right at `xl` and above; below the hero on
  //   smaller viewports.
  //
  // On wide viewports the outer fills the parent's `h-screen` and the
  // two columns scroll independently — the hero column for its own
  // overflow (e.g. many recent tabs), the rail for its own overflow
  // (e.g. expanded Memory + Skills). The whole page never scrolls,
  // which keeps the chat composer visually pinned in the centered
  // hero. On narrow viewports the columns stack and the page itself
  // scrolls naturally; the rail loses its left border.

  if (!space) {
    return (
      <div
        {...pageDndHandlers}
        className={cn(
          "relative flex flex-col items-center justify-center min-h-screen px-6 py-12 transition-colors",
          pageDragOver && "bg-blue-500/5",
        )}
      >
        <div className="w-full max-w-xl flex flex-col items-center gap-8">
          <Wordmark className="h-7 w-auto" />
          <HeroComposer
            chatInputRef={chatInputRef}
            space={null}
            input={input}
            setInput={setInput}
            handleSubmit={handleSubmit}
            handleSuggestion={handleSuggestion}
            handleTabCardClick={handleTabCardClick}
            recentTabs={recentTabs}
            isConfigured={isConfigured}
            providerModels={providerModels}
            settings={settings}
            updateSettings={updateSettings}
            agentSettings={agentSettings}
            setAgentSettings={setAgentSettings}
            providers={providers}
            mode={mode}
            onModeChange={setMode}
            focusTrigger={focusTrigger}
          />
        </div>
        {pageDragOver && <PageDropOverlay />}
      </div>
    );
  }

  const heroContent = (
    <div className="w-full max-w-xl flex flex-col items-center gap-8 mx-auto">
      <Wordmark className="h-7 w-auto" />
      <HeroComposer
        chatInputRef={chatInputRef}
        space={space}
        input={input}
        setInput={setInput}
        handleSubmit={handleSubmit}
        handleSuggestion={handleSuggestion}
        handleTabCardClick={handleTabCardClick}
        recentTabs={recentTabs}
        isConfigured={isConfigured}
        providerModels={providerModels}
        settings={settings}
        updateSettings={updateSettings}
        agentSettings={agentSettings}
        setAgentSettings={setAgentSettings}
        providers={providers}
        mode={mode}
        onModeChange={setMode}
        focusTrigger={focusTrigger}
      />
    </div>
  );

  const heroColumnClass = cn(
    // Narrow viewports: hero column fills the viewport below the (sticky)
    // header so the customization rail (Instructions / Files / …) sits below
    // the fold and is only revealed on scroll. The CSS variable is published
    // by the layout effect above; the `7rem` fallback covers first paint
    // before the ResizeObserver has measured.
    "min-h-[calc(100svh-var(--landing-header-h,7rem))] flex flex-col items-center justify-center",
    "xl:min-h-0",
    "flex-1 min-w-0 px-6 py-12",
    "xl:overflow-y-auto xl:flex xl:flex-col xl:items-center xl:justify-center",
  );

  // The aside body switches between the file viewer and the customization
  // rail with the same slide transition the chat RightRail uses.
  const asideBody = (
    <div className="relative h-full w-full overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        {selectedSpaceFile !== null || selectedMemoryFile !== null ? (
          <motion.div
            key="space-file"
            className="absolute inset-0"
            initial={{ x: -16, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -16, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {selectedMemoryFile !== null ? (
              <FileViewerPanel
                filePath={selectedMemoryFile}
                fileName={
                  selectedMemoryFile.split("/").pop() ?? selectedMemoryFile
                }
                spaceId={space.id}
                openInNewTab
                headerActions={
                  <MemoryDeleteButton
                    path={selectedMemoryFile}
                    onDeleted={() => setSelectedMemoryFile(null)}
                  />
                }
                contentHeader={<MemoryFileMeta path={selectedMemoryFile} />}
                onWikiLink={handleMemoryWikiLink}
                onChatLink={handleMemoryChatLink}
                onClose={() => setSelectedMemoryFile(null)}
              />
            ) : (
              <FileViewerPanel
                filePath={`spaces/${space.id}/workspace/${selectedSpaceFile}`}
                fileName={
                  selectedSpaceFile!.split("/").pop() ?? selectedSpaceFile!
                }
                spaceId={space.id}
                openInNewTab
                onClose={() => setSelectedSpaceFile(null)}
              />
            )}
          </motion.div>
        ) : (
          <motion.div
            key="customization"
            className="absolute inset-0 overflow-y-auto"
            initial={{ x: 16, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 16, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <SpaceCustomization
              space={space}
              onSelectFile={handleSelectSpaceFile}
              onSelectMemoryFile={handleSelectMemoryFile}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  return (
    <div
      {...pageDndHandlers}
      ref={outerRef}
      className={cn(
        "relative flex flex-col xl:h-full xl:min-h-0 min-h-screen transition-colors",
        pageDragOver && "bg-blue-500/5",
      )}
    >
      <SpaceLandingHeader space={space} headerRef={headerRef} />

      {isXl ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 min-h-0"
        >
          <ResizablePanel
            minSize="400px"
            groupResizeBehavior="preserve-relative-size"
          >
            <div className={heroColumnClass}>{heroContent}</div>
          </ResizablePanel>
          <ResizableHandle
            // Only draggable in file mode. In customization mode the handle is
            // hidden (non-interactive, transparent) so the rail keeps its fixed
            // width like the original layout.
            disabled={!inFileMode}
            className={
              inFileMode
                ? undefined
                : "bg-transparent! cursor-default after:hidden"
            }
          />
          <ResizablePanel
            panelRef={asidePanelRef}
            defaultSize={initialAsideSize}
            minSize={
              inFileMode ? `${FILE_MIN_PX}px` : `${CUSTOMIZATION_WIDTH_PX}px`
            }
            maxSize={inFileMode ? maxAsidePx : `${CUSTOMIZATION_WIDTH_PX}px`}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(panelSize: PanelSize) => {
              if (animatingRef.current) return;
              if (panelSize.inPixels > 0 && inFileModeRef.current) {
                setFileWidthPx(Math.round(panelSize.inPixels));
              }
            }}
            className="border-l border-border bg-background"
          >
            {asideBody}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-col">
          <div className={heroColumnClass}>{heroContent}</div>
          <aside className="w-full border-t border-border">
            {selectedMemoryFile !== null ? (
              <FileViewerPanel
                filePath={selectedMemoryFile}
                fileName={
                  selectedMemoryFile.split("/").pop() ?? selectedMemoryFile
                }
                spaceId={space.id}
                openInNewTab
                headerActions={
                  <MemoryDeleteButton
                    path={selectedMemoryFile}
                    onDeleted={() => setSelectedMemoryFile(null)}
                  />
                }
                contentHeader={<MemoryFileMeta path={selectedMemoryFile} />}
                onWikiLink={handleMemoryWikiLink}
                onChatLink={handleMemoryChatLink}
                onClose={() => setSelectedMemoryFile(null)}
              />
            ) : selectedSpaceFile !== null ? (
              <FileViewerPanel
                filePath={`spaces/${space.id}/workspace/${selectedSpaceFile}`}
                fileName={
                  selectedSpaceFile.split("/").pop() ?? selectedSpaceFile
                }
                spaceId={space.id}
                openInNewTab
                onClose={() => setSelectedSpaceFile(null)}
              />
            ) : (
              <SpaceCustomization
                space={space}
                onSelectFile={handleSelectSpaceFile}
                onSelectMemoryFile={handleSelectMemoryFile}
              />
            )}
          </aside>
        </div>
      )}
      {pageDragOver && <PageDropOverlay />}
    </div>
  );
}

/**
 * Centered, non-interactive overlay shown while a file is being dragged
 * over the LandingPage (outside the Files-section dropzone). The toast
 * is opaque so it reads cleanly against any underlying content.
 */
function PageDropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
      <div className="flex items-center gap-2 rounded-md bg-background/95 px-4 py-2 shadow-lg border border-blue-500/40">
        <Upload className="size-4 text-blue-500" />
        <span className="text-sm font-medium">
          Drop files to attach to message
        </span>
      </div>
    </div>
  );
}

/**
 * Page-spanning header for the chat LandingPage when a space is
 * active. Replaces both the old read-only `SpaceHeader` (which sat
 * above the chat composer) and the previous in-rail sticky header.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │ [icon] [name input         ] [color] [tabs]  │
 *   │        Add a description...                  │
 *   └──────────────────────────────────────────────┘
 *
 * Sticky behavior: on wide viewports (≥xl) the LandingPage's outer
 * frame is `h-full`, the header sits above a `flex-1 min-h-0` row
 * that scrolls inside its columns — the header doesn't *need* sticky
 * because nothing scrolls past it. On narrow viewports the page
 * itself scrolls, so the header is `sticky top-0` to remain visible
 * while the user scrolls through hero + customization.
 *
 * All controls autosave: name + description on blur (with empty-name
 * revert to persisted value), icon + color on selection. `Esc` cancels
 * a name/description edit; `Enter` blurs (committing). The tab counts
 * to the right reflect the active window's state, same numbers shown
 * on the previous read-only `SpaceHeader`.
 */
function SpaceLandingHeader({
  space,
  headerRef,
}: {
  space: Space;
  headerRef?: React.Ref<HTMLElement>;
}) {
  const [draftName, setDraftName] = useState(space.name);
  const [draftDescription, setDraftDescription] = useState(
    space.description ?? "",
  );

  // Re-sync from the upstream `space` row whenever it changes (e.g.
  // after our own save commits, or after a cross-context update from
  // another extension surface). Without this, an external rename
  // would leave the input showing stale text.
  useEffect(() => {
    setDraftName(space.name);
  }, [space.id, space.name]);

  useEffect(() => {
    setDraftDescription(space.description ?? "");
  }, [space.id, space.description]);

  const systemDark = useMemo(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    [],
  );

  async function commitName() {
    const trimmed = draftName.trim();
    if (!trimmed) {
      // The space MUST have a name; an empty trimmed value snaps back
      // to the persisted value rather than failing visibly.
      setDraftName(space.name);
      return;
    }
    if (trimmed === space.name) return;
    await storage.updateSpace(space.id, { name: trimmed });
  }

  async function commitDescription() {
    const trimmed = draftDescription.trim();
    const next = trimmed ? trimmed : null;
    if (next === (space.description ?? null)) return;
    await storage.updateSpace(space.id, { description: next });
  }

  async function saveIcon(icon: string | null) {
    await storage.updateSpace(space.id, { icon });
  }

  async function saveColor(
    colors: string[] | null,
    colorMode: "auto" | "light" | "dark" | null,
  ) {
    await storage.updateSpace(space.id, { colors, colorMode });
  }

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-10 xl:static bg-background border-b border-border px-6 py-4 space-y-2"
    >
      <div className="flex items-center gap-2">
        <IconPickerButton
          icon={space.icon}
          onChange={saveIcon}
          ariaLabel={`Change icon for ${space.name}`}
        />
        {/* `field-sizing-content` makes the input hug its rendered
            text width; `min-w-[6rem]` keeps an empty input clickable;
            `max-w-full` clamps to the row so a runaway-long name
            can't push the color picker off-screen. The shadcn `Input`
            primitive brings the standard border, focus ring, and
            disabled states; `h-9` overrides its default `h-8` so the
            row visually aligns with the icon picker. */}
        <Input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraftName(space.name);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Space name"
          aria-label="Space name"
          className="field-sizing-content min-w-[6rem] max-w-full h-9 w-auto text-sm font-medium"
        />
        <div className="flex-1" />
        <ColorPickerDialog
          space={space}
          systemDark={systemDark}
          onSave={saveColor}
        />
      </div>
      <input
        value={draftDescription}
        onChange={(e) => setDraftDescription(e.target.value)}
        onBlur={() => void commitDescription()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraftDescription(space.description ?? "");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Describe your project, goals, subject, etc..."
        aria-label="Space description"
        className="w-full h-8 border-0 bg-transparent px-0 text-xs text-muted-foreground placeholder:text-muted-foreground/60 outline-none focus:text-foreground"
      />
    </header>
  );
}

/**
 * The centered chat composer + suggestions + recent tabs strip. Same
 * markup we've shipped on the LandingPage forever — extracted into a
 * sub-component so the active-space layout can wrap it inside a sized
 * column without duplicating the children.
 */
interface HeroComposerProps {
  space: Space | null;
  input: string;
  setInput: (next: string) => void;
  handleSubmit: (
    mentions: TabMentionAttrs[],
    attachments: Attachment[],
  ) => Promise<void>;
  handleSuggestion: (text: string) => void;
  handleTabCardClick: (tab: { title: string; url: string }) => void;
  recentTabs: ReturnType<typeof useRecentTabs>;
  isConfigured: boolean;
  providerModels: ReturnType<typeof useProviders>["providers"] extends infer _T
    ? Array<{
        provider: string;
        label: string;
        models: ReturnType<typeof useProviders>["providers"][number]["models"];
        enabled: boolean;
      }>
    : never;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  agentSettings: AgentSettings;
  setAgentSettings: (next: AgentSettings) => void;
  providers: ReturnType<typeof useProviders>["providers"];
  /**
   * Pre-conversation approval mode picker state. Lives on the parent
   * (LandingPage) because it's read into `chatDb.createConversation`
   * at submit time (`handleSubmit`); the composer just renders the
   * picker and forwards changes back up via `onModeChange`.
   */
  mode: ConversationMode;
  onModeChange: (next: ConversationMode) => void;
  chatInputRef?: React.Ref<ChatInputHandle>;
  /**
   * Bumped by the parent (LandingPage) when a one-shot refocus is
   * desired, e.g. after the newtab page first gains window focus.
   * Forwarded to ChatInput's `focusTrigger`. Null when no refocus is
   * pending so the ChatInput's effect doesn't fire on every render.
   */
  focusTrigger?: string | null;
}

function HeroComposer({
  space,
  input,
  setInput,
  handleSubmit,
  handleSuggestion,
  handleTabCardClick,
  recentTabs,
  isConfigured,
  providerModels,
  settings,
  updateSettings,
  agentSettings,
  setAgentSettings,
  providers,
  mode,
  onModeChange,
  chatInputRef,
  focusTrigger,
}: HeroComposerProps) {
  return (
    <>
      {/* Hero chat input. `ChatInputHalo` paints the gradient outline
          when a space color is set and the composer is focused. */}
      <ChatInputHalo space={space}>
        <div className="w-full">
          <ChatInput
          ref={chatInputRef}
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onCommand={({ command }) => {
            // The landing page has no active conversation, so there's
            // nothing to compact. Acknowledge the command instead of
            // silently sending it as text.
            if (command === "compact") {
              toast.info("Nothing to compact yet");
            }
          }}
          isLoading={false}
          disabled={!isConfigured}
          autoFocus
          focusTrigger={focusTrigger}
          providerModels={providerModels}
          favoriteModels={settings.favoriteModels}
          onFavoriteToggle={(modelKey) => {
            const favoriteModels = settings.favoriteModels.includes(modelKey)
              ? settings.favoriteModels.filter((k) => k !== modelKey)
              : [...settings.favoriteModels, modelKey];
            updateSettings({ favoriteModels });
          }}
          selectedModel={agentSettings.agentModel}
          onModelChange={(modelId) => {
            const updated = { ...agentSettings, agentModel: modelId };
            setAgentSettings(updated);
            storage.setAgentSettings(updated);
          }}
          mode={mode}
          onModeChange={onModeChange}
          thinkingEnabled={agentSettings.thinkingEnabled}
          thinkingConfig={agentSettings.thinkingConfig}
          onThinkingChange={(enabled, config) => {
            const updated = {
              ...agentSettings,
              thinkingEnabled: enabled,
              thinkingConfig: config ?? agentSettings.thinkingConfig,
            };
            setAgentSettings(updated);
            storage.setAgentSettings(updated);
          }}
          selectedModelCapabilities={(() => {
            const parts = agentSettings.agentModel.split(":");
            const hasProvider = parts.length > 1;
            const targetProviderId = hasProvider ? parts[0] : undefined;
            const actualId = hasProvider
              ? parts.slice(1).join(":")
              : agentSettings.agentModel;
            const provider = providers.find((p) =>
              hasProvider
                ? p.id === targetProviderId
                : p.models.some((m) => m.id === actualId),
            );
              return provider?.models.find((m) => m.id === actualId)
                ?.capabilities;
          })()}
          />
          {!isConfigured && (
            <button
              type="button"
              onClick={() => void openSettingsTab("models")}
              className="mt-2 w-full text-center text-xs text-primary hover:underline"
            >
              Set up an AI model to get started
            </button>
          )}
        </div>
      </ChatInputHalo>

      {/* Suggestion buttons */}
      {isConfigured && (
        <Suggestions>
          {SUGGESTIONS.map((s) => (
            <Suggestion key={s} suggestion={s} onClick={handleSuggestion} />
          ))}
        </Suggestions>
      )}

      {/* Recent tab cards */}
      {recentTabs.length > 0 && (
        <div className="w-full">
          <h2 className="text-xs font-medium text-muted-foreground mb-2">
            Recent tabs
          </h2>
          <div className="flex flex-wrap gap-2">
            {recentTabs.map((tab) => (
              <TabCard
                key={tab.id}
                title={tab.title}
                url={tab.url}
                favicon={tab.favicon}
                onClick={() => handleTabCardClick(tab)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
