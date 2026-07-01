import { formatMessageAsMarkdown } from "@/lib/format-markdown";
import { ChatView } from "@/components/chat/ChatView";
import { ContextUsage } from "@/components/chat/ContextUsage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActiveTabs } from "@/hooks/useActiveTabs";
import { useTheme } from "@/hooks/useTheme";
import { useFilePanelWidth } from "@/hooks/useFilePanelWidth";
import { FileSelectionContext } from "@/lib/file-selection-context";
import { artifactsEvents, type ArtifactCreatedDetail } from "@/lib/artifacts/events";
import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import {
  Clock,
  CopyIcon,
  Download,
  Ellipsis,
  FileDown,
  PanelRight,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HomeSidebar } from "./components/HomeSidebar";
import { LandingPage } from "./components/LandingPage";
import { LibraryView } from "./components/LibraryView";
import { RightRail } from "./components/RightRail";
import { ScheduledView } from "./components/ScheduledView";
import { ScheduledRunHost } from "./components/ScheduledRunHost";
import { SpacesPage } from "./components/SpacesPage";
import {
  formatHomeRoute,
  parseHomeRoute,
  sameView,
  type HomeRoute,
} from "./route";
import {
  type Surface,
  shouldHostScheduledRuns,
  resolveInitialSpaceId,
  formatDocumentTitle,
} from "./surface";

interface HomeAppProps {
  surface: Surface;
}

export default function HomeApp({ surface }: HomeAppProps) {
  useTheme();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);

  // Single source of truth for which view is mounted (`chat` / `scheduled`
  // / `spaces`), the active conversation id (when on chat), and the
  // selected space id (when on the Spaces detail). Persisted in the URL
  // hash so reload, back/forward, and direct deep-links all work.
  // See `./route.ts` for the grammar.
  const [route, setRoute] = useState<HomeRoute>(() =>
    parseHomeRoute(window.location.hash),
  );

  // Derived view scalars — kept around for ergonomic JSX and so that
  // existing render branches read naturally. Don't set these directly;
  // mutate via `setRoute` (which writes the URL) and they update.
  const view = route.view;
  const activeConversationId =
    route.view === "chat" ? route.conversationId : null;

  // Track the most recent hash we wrote so the URL→state listener can
  // ignore self-induced events. The URL is the source of truth, but
  // `navigate` writes it before the next `hashchange` fires; we don't
  // want a redundant `setRoute` (it'd be a no-op via React's bail-out,
  // but it's clearer to short-circuit explicitly).
  const lastWrittenHashRef = useRef<string>(window.location.hash);
  const routeRef = useRef(route);
  routeRef.current = route;

  /**
   * Single navigation entry point: sets the route state and writes the
   * URL. Uses `pushState` for view transitions (Back navigates between
   * views) and `replaceState` for incidental same-view updates (e.g.
   * switching conversations within chat — back-spam-free, matching the
   * pre-routing behavior of the conversation-id sync).
   */
  const navigate = useCallback((next: HomeRoute) => {
    const prev = routeRef.current;
    const nextHash = formatHomeRoute(next);
    const url =
      window.location.pathname +
      window.location.search +
      (nextHash || "");
    const isViewChange = !sameView(prev, next);
    if (window.location.hash !== nextHash) {
      if (isViewChange) {
        history.pushState(null, "", url || window.location.pathname);
      } else {
        history.replaceState(null, "", url || window.location.pathname);
      }
    }
    lastWrittenHashRef.current = nextHash;
    // Update the ref synchronously so back-to-back navigate() calls in
    // the same React batch (e.g. setView + setActiveConversationId)
    // see the updated previous-route and don't double-push.
    routeRef.current = next;
    setRoute(next);
  }, []);

  /**
   * Backward-compatible shims so existing call sites don't need to learn
   * `navigate(route)`. Each shim translates a familiar set/clear into a
   * route delta and routes through `navigate`.
   */
  const setView = useCallback(
    (v: "chat" | "scheduled" | "spaces" | "library") => {
      const prev = routeRef.current;
      if (v === "chat") {
        navigate({
          view: "chat",
          // Preserve the active conversation if we're already on chat;
          // otherwise switch to empty chat. (Existing call sites that
          // want to land on a specific conversation pair `setView("chat")`
          // with a follow-up `setActiveConversationId(id)` — the second
          // call is what writes the id.)
          conversationId:
            prev.view === "chat" ? prev.conversationId : null,
        });
      } else if (v === "scheduled") {
        navigate({ view: "scheduled" });
      } else if (v === "library") {
        navigate({ view: "library" });
      } else {
        navigate({ view: "spaces" });
      }
    },
    [navigate],
  );

  const setActiveConversationId = useCallback(
    (id: string | null) => {
      // Convo changes always belong to the chat view. Existing call
      // sites that target chat already pair this with `setView("chat")`;
      // call sites that fire while on another view (none in practice,
      // see App.tsx delete path) would silently switch to chat — but
      // those paths only run while on chat anyway, so this is a no-op
      // in those cases (sameView ⇒ replaceState, not pushState).
      navigate({ view: "chat", conversationId: id });
    },
    [navigate],
  );

  // Prefill consumed once on mount — used by the "Try in chat" flow from
  // Settings. Reading from URL synchronously avoids a flicker, and we
  // history.replaceState the param away so a refresh doesn't re-seed.
  const [initialInput] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    const prefill = params.get("prefill");
    if (!prefill) return undefined;
    // Strip the param from the URL without disturbing the hash (which
    // carries the active route).
    params.delete("prefill");
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname +
      (newSearch ? `?${newSearch}` : "") +
      window.location.hash;
    history.replaceState(null, "", newUrl);
    return prefill;
  });
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayAction, setOverlayAction] = useState<string | null>(null);
  const overlayIframeRef = useRef<HTMLIFrameElement>(null);

  const scheduleModels = useScheduleModels();

  const [conversationTitle, setConversationTitle] = useState<string | null>(
    null,
  );
  /**
   * Set when the active conversation has `source === "mcp"`. We
   * surface a small banner above the chat so the user understands
   * this conversation was started by an external MCP host (it
   * doesn't appear in the sidebar list — sidebar filters MCP rows —
   * so without a banner the user has no context for why this
   * conversation exists or who initiated it).
   */
  const [activeMcpHostName, setActiveMcpHostName] = useState<string | null>(
    null,
  );
  const [isCoworkPanelOpen, setIsCoworkPanelOpen] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedSpaceFile, setSelectedSpaceFile] = useState<string | null>(
    null,
  );
  // Artifact open in the rail's in-panel viewer. Mutually exclusive with the
  // file/space-file selections — only one viewer occupies the rail at a time.
  const [selectedArtifact, setSelectedArtifact] = useState<
    { id: string; title: string } | null
  >(null);
  const [filePanelWidth, setFilePanelWidth] = useFilePanelWidth();
  const [generatingTitleIds, setGeneratingTitleIds] = useState<Set<string>>(
    new Set(),
  );

  // Clear any active space-file selection when the active space changes
  // to prevent the viewer from trying to read from a missing space.
  useEffect(() => {
    if (!activeSpaceId) setSelectedSpaceFile(null);
  }, [activeSpaceId]);

  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) ?? null;
  const allActiveTabs = useActiveTabs(activeSpace?.windowId ?? null);
  const pinnedCount = allActiveTabs.filter((t) => t.pinned).length;

  useEffect(() => {
    async function init() {
      const allSpaces = await storage.getSpaces();
      setSpaces(allSpaces);

      // Resolution order is in resolveInitialSpaceId: home prefers the
      // durable ?space=<id> anchor, then windowId match, then null
      // (space-less is first-class). Newtab skips the URL param and
      // goes straight to windowId match.
      const currentWindow = await chrome.windows.getCurrent();
      const resolvedId = resolveInitialSpaceId({
        surface,
        urlSearch: window.location.search,
        currentWindowId: currentWindow.id,
        spaces: allSpaces,
      });
      setActiveSpaceId(resolvedId);
    }
    init();

    const listener = () => {
      init();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [surface]);

  useEffect(() => {
    const listener = (message: { type: string; action?: string }) => {
      if (message.type === "TOGGLE_HOME_OVERLAY") {
        if (message.action) {
          setOverlayAction(message.action);
          setShowOverlay(true);
        } else {
          setShowOverlay((prev) => !prev);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const handleKeydown = (e: KeyboardEvent) => {
      if (
        e.key === "k" &&
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        setShowOverlay((prev) => !prev);
      }
      if (e.key === "Escape" && showOverlay) {
        setShowOverlay(false);
      }
    };
    document.addEventListener("keydown", handleKeydown);

    const handleMessage = (e: MessageEvent) => {
      // Only accept messages from our own overlay iframe. The overlay is
      // served from the same chrome-extension origin and identifies itself
      // by being the iframe's contentWindow. This guards against any
      // cross-context postMessage that could otherwise toggle our overlay
      // state — flagged by CodeQL as a missing origin check.
      if (e.origin !== window.location.origin) return;
      if (e.source && e.source !== overlayIframeRef.current?.contentWindow) return;
      if (e.data?.type === "OPENBROWSE_OVERLAY_CLOSE") {
        setShowOverlay(false);
        setOverlayAction(null);
      }
      if (
        e.data?.type === "OPENBROWSE_OVERLAY_RESIZE" &&
        typeof e.data.height === "number" &&
        overlayIframeRef.current
      ) {
        overlayIframeRef.current.style.height = `${e.data.height}px`;
      }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("message", handleMessage);
    };
  }, [showOverlay]);

  useEffect(() => {
    document.title = formatDocumentTitle(
      surface,
      activeSpace?.name ?? null,
      conversationTitle,
    );
    if (!activeSpace) return;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }

    if (activeSpace.icon) {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.font = "52px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(activeSpace.icon, 32, 36);
        link.href = canvas.toDataURL("image/png");
      }
    } else {
      link.href = "";
    }
  }, [activeSpace, surface, conversationTitle]);

  // URL → state. Listens to both `hashchange` (e.g. background's
  // `FOCUS_CONVERSATION` rewriting `...#<conversationId>` to switch the
  // home tab to a chat) and `popstate` (Back/Forward, which doesn't
  // always fire `hashchange`). Self-induced writes from `navigate` are
  // skipped via `lastWrittenHashRef`.
  useEffect(() => {
    function onLocationChange() {
      const currentHash = window.location.hash;
      if (currentHash === lastWrittenHashRef.current) return;
      lastWrittenHashRef.current = currentHash;
      const next = parseHomeRoute(currentHash);
      // Avoid redundant re-renders if the parsed route is already
      // structurally equal to what we have (rare but possible if some
      // external code rewrote the hash to the same value).
      const prev = routeRef.current;
      if (
        prev.view === next.view &&
        ((prev.view === "chat" &&
          next.view === "chat" &&
          prev.conversationId === next.conversationId) ||
          prev.view === "spaces" ||
          prev.view === "scheduled" ||
          prev.view === "library")
      ) {
        return;
      }
      setRoute(next);
    }
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    return () => {
      window.removeEventListener("hashchange", onLocationChange);
      window.removeEventListener("popstate", onLocationChange);
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setConversationTitle(null);
      setActiveMcpHostName(null);
      setSelectedFile(null);
      setSelectedSpaceFile(null);
      setSelectedArtifact(null);
      return;
    }
    setIsCoworkPanelOpen(true);
    setSelectedFile(null);
    setSelectedSpaceFile(null);
    setSelectedArtifact(null);
    // Clear MCP banner synchronously before the async fetch resolves.
    // Otherwise, switching from an MCP conv to a non-MCP conv briefly
    // renders the previous MCP host's banner above the new chat until
    // getConversation returns.
    setActiveMcpHostName(null);
    // Guard against stale resolutions: if `activeConversationId` flips
    // again before this getConversation resolves (rapid sidebar clicks),
    // discard the late response so it can't overwrite the title we've
    // since picked up for a different conversation.
    let cancelled = false;
    chatDb.getConversation(activeConversationId).then((conv) => {
      if (cancelled) return;
      setConversationTitle(conv?.title ?? null);
      setActiveMcpHostName(
        conv?.source === "mcp" ? conv.mcpHostName ?? "MCP host" : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  useEffect(() => {
    function onGenerating(e: Event) {
      const id = (e as CustomEvent).detail?.id;
      if (id) setGeneratingTitleIds((prev) => new Set(prev).add(id));
    }
    function onUpdated(e: Event) {
      const { id, title } = (e as CustomEvent).detail ?? {};
      if (id) {
        setGeneratingTitleIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        if (title && id === activeConversationIdRef.current) {
          setConversationTitle(title);
        }
      }
    }
    window.addEventListener("chat-title-generating", onGenerating);
    window.addEventListener("chat-title-updated", onUpdated);
    return () => {
      window.removeEventListener("chat-title-generating", onGenerating);
      window.removeEventListener("chat-title-updated", onUpdated);
    };
  }, []);

  const buildChatMarkdown = useCallback(async () => {
    if (!activeConversationId) return null;
    const [conv, messages] = await Promise.all([
      chatDb.getConversation(activeConversationId),
      chatDb.getMessages(activeConversationId),
    ]);
    const lines = messages
      .map((m) => {
        const role = m.role === "user" ? "You" : "Assistant";
        const content = formatMessageAsMarkdown(m);
        if (!content) return null;
        return `## ${role}\n\n${content}`;
      })
      .filter(Boolean);
    const markdown = `# ${conv?.title ?? "Chat"}\n\n${lines.join("\n\n---\n\n")}`;
    return { markdown, title: conv?.title ?? "chat" };
  }, [activeConversationId]);

  const handleCopyChatMarkdown = useCallback(async () => {
    const built = await buildChatMarkdown();
    if (!built) return;
    try {
      await navigator.clipboard.writeText(built.markdown);
      toast.success("Chat copied as markdown");
    } catch {
      toast.error("Failed to copy chat");
    }
  }, [buildChatMarkdown]);

  const handleExportChat = useCallback(async () => {
    const built = await buildChatMarkdown();
    if (!built) return;
    const blob = new Blob([built.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${built.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildChatMarkdown]);

  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleRenameConversation = useCallback(
    (conv: { id: string; title: string }) => {
      setRenameValue(conv.title);
      setRenameTarget(conv);
    },
    [],
  );

  const handleRenameChat = useCallback(() => {
    if (!activeConversationId) return;
    handleRenameConversation({
      id: activeConversationId,
      title: conversationTitle ?? "",
    });
  }, [activeConversationId, conversationTitle, handleRenameConversation]);

  const confirmRename = useCallback(async () => {
    if (!renameTarget || !renameValue.trim()) return;
    await chatDb.updateConversation(renameTarget.id, {
      title: renameValue.trim(),
    });
    if (renameTarget.id === activeConversationId) {
      setConversationTitle(renameValue.trim());
    }
    setRenameTarget(null);
  }, [renameTarget, renameValue, activeConversationId]);

  const handleDeleteConversation = useCallback(
    (conv: { id: string; title: string }) => {
      setDeleteTarget(conv);
    },
    [],
  );

  const handleDeleteChat = useCallback(() => {
    if (!activeConversationId) return;
    handleDeleteConversation({
      id: activeConversationId,
      title: conversationTitle ?? "",
    });
  }, [activeConversationId, conversationTitle, handleDeleteConversation]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const prevActive = activeConversationId;
    setDeleteTarget(null);
    // Optimistically drop the row from the sidebar list immediately.
    window.dispatchEvent(
      new CustomEvent("chat-deleted", { detail: { id: target.id } }),
    );
    if (target.id === activeConversationId) {
      setActiveConversationId(null);
    }
    try {
      await chatDb.deleteConversation(target.id);
    } catch {
      // Reconcile the optimistic removal if the delete actually failed:
      // restore the sidebar row and, if we cleared the active view for
      // this conversation, restore that too.
      window.dispatchEvent(
        new CustomEvent("chat-deleted-failed", { detail: { id: target.id } }),
      );
      if (target.id === prevActive) {
        setActiveConversationId(prevActive);
      }
    }
  }, [deleteTarget, activeConversationId]);

  const handleNewConversation = useCallback((id: string) => {
    setView("chat");
    if (id) {
      setActiveConversationId(id);
    } else {
      setActiveConversationId(null);
    }
  }, []);

  const handleSelectConversation = useCallback((id: string) => {
    setView("chat");
    setActiveConversationId(id);
  }, []);

  const handleOpenScheduled = useCallback(() => setView("scheduled"), []);

  // Per-chat "Schedule": open the conversation (if not already active) and
  // seed its composer with "/schedule " so the schedule skill is invoked.
  // The slash token auto-forms a skill mention at start-of-line.
  const handleScheduleConversation = useCallback(
    (conv: { id: string; title: string }) => {
      setView("chat");
      setActiveConversationId(conv.id);
      // Defer so ChatView for this conversation is mounted/listening.
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("seed-chat-input", {
            detail: { conversationId: conv.id, text: "/schedule " },
          }),
        );
      }, 50);
    },
    [],
  );

  // "Create with agent" from the Scheduled view: open a fresh chat and seed
  // it with "/schedule " so the user can describe the task conversationally.
  const handleCreateScheduleWithAgent = useCallback(() => {
    setView("chat");
    setActiveConversationId(null);
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("seed-chat-input", {
          detail: { conversationId: null, text: "/schedule " },
        }),
      );
    }, 50);
  }, []);

  const handleSelectFile = useCallback((file: string | null) => {
    setSelectedFile(file);
    if (file !== null) {
      // Mutually exclusive with the space-file / artifact selections — only one
      // viewer can occupy the rail at a time.
      setSelectedSpaceFile(null);
      setSelectedArtifact(null);
      // Selecting a file always implies the rail should be visible.
      setIsCoworkPanelOpen(true);
    }
  }, []);

  const handleSelectArtifact = useCallback(
    (artifact: { id: string; title: string } | null) => {
      setSelectedArtifact(artifact);
      if (artifact !== null) {
        // Mutually exclusive with the file selections.
        setSelectedFile(null);
        setSelectedSpaceFile(null);
        setIsCoworkPanelOpen(true);
      }
    },
    [],
  );

  // Auto-open a newly created artifact in the in-panel viewer. The
  // create_artifact tool fires `artifacts:created`; opening the viewer makes
  // the artifact actually run, which is what lets the agent's follow-up
  // read_artifact_diagnostics get a live signal instead of "never mounted".
  useEffect(() => {
    const onCreated = (e: Event) => {
      const detail = (e as CustomEvent<ArtifactCreatedDetail>).detail;
      if (detail?.id) {
        handleSelectArtifact({ id: detail.id, title: detail.title });
      }
    };
    artifactsEvents.addEventListener("artifacts:created", onCreated);
    return () =>
      artifactsEvents.removeEventListener("artifacts:created", onCreated);
  }, [handleSelectArtifact]);

  const handleSelectSpaceFile = useCallback(
    (file: string | null) => {
      // Defense-in-depth: a non-null selection requires an active space, since
      // the viewer reads from `spaces/<spaceId>/workspace/<file>`. Currently
      // unreachable (the conversation's space is fixed at creation and rows
      // can only acquire `referencedSpaceFiles` while in a space), but cheap
      // to guard so a future loosening of that invariant can't render an
      // empty/broken rail.
      if (file !== null && activeSpaceId === null) return;
      setSelectedSpaceFile(file);
      if (file !== null) {
        // Mutually exclusive with the conversation-file / artifact selections.
        setSelectedFile(null);
        setSelectedArtifact(null);
        // Selecting a file always implies the rail should be visible.
        setIsCoworkPanelOpen(true);
      }
    },
    [activeSpaceId],
  );

  const handleToggleCowork = useCallback(() => {
    setIsCoworkPanelOpen((prev) => !prev);
  }, []);

  return (
    <div className="flex h-screen bg-[var(--background)]">
      {shouldHostScheduledRuns(surface) ? <ScheduledRunHost /> : null}
      <HomeSidebar
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        activeConversationId={
          view === "scheduled" ||
          view === "spaces" ||
          view === "library"
            ? null
            : activeConversationId
        }
        scheduledActive={view === "scheduled"}
        spacesActive={view === "spaces"}
        libraryActive={view === "library"}
        onSelectConversation={handleSelectConversation}
        onNewConversation={() => handleNewConversation("")}
        onGoHome={() => {
          setView("chat");
          setActiveConversationId(null);
        }}
        onOpenOverlay={() => setShowOverlay(true)}
        onOpenSpaces={() => navigate({ view: "spaces" })}
        onOpenLibrary={() => setView("library")}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        onOpenScheduled={handleOpenScheduled}
        onScheduleConversation={handleScheduleConversation}
      />

      {view === "library" ? (
        <LibraryView />
      ) : view === "spaces" ? (
        <SpacesPage activeSpaceId={activeSpaceId} />
      ) : view === "scheduled" ? (
        <ScheduledView
          models={scheduleModels}
          onOpenConversation={(id) => {
            setView("chat");
            handleSelectConversation(id);
          }}
          onCreateWithAgent={handleCreateScheduleWithAgent}
        />
      ) : activeConversationId ? (
        <FileSelectionContext.Provider value={handleSelectFile}>
        <RightRail
          conversationId={activeConversationId}
          spaceId={activeSpaceId}
          selectedFile={selectedFile}
          onSelectFile={handleSelectFile}
          selectedSpaceFile={selectedSpaceFile}
          onSelectSpaceFile={handleSelectSpaceFile}
          selectedArtifact={selectedArtifact}
          onSelectArtifact={handleSelectArtifact}
          isOpen={isCoworkPanelOpen}
          fileWidthPx={filePanelWidth}
          onFileWidthChange={setFilePanelWidth}
          centerSlot={
            <main className="h-full min-w-0 flex flex-col">
              <div className="sticky top-0 z-10 flex items-center justify-between px-4 pt-2 pb-px bg-background/80 backdrop-blur-md after:absolute after:inset-x-0 after:-bottom-6 after:h-6 after:bg-linear-to-b after:from-background after:to-transparent after:pointer-events-none">
                <span
                  className={`text-sm font-medium truncate min-w-0 ${generatingTitleIds.has(activeConversationId) ? "shimmer-text" : ""}`}
                >
                  {conversationTitle ?? "New conversation"}
                </span>
                <div className="flex items-center gap-1">
                  <ContextUsage conversationId={activeConversationId} />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Ellipsis className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          if (!activeConversationId) return;
                          void handleScheduleConversation({
                            id: activeConversationId,
                            title: conversationTitle ?? "New conversation",
                          });
                        }}
                      >
                        <Clock className="size-3.5" />
                        Schedule
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleRenameChat}>
                        <Pencil className="size-3.5" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Download className="size-3.5" />
                          Export chat
                        </DropdownMenuSubTrigger>
                        <DropdownMenuPortal>
                          <DropdownMenuSubContent
                            sideOffset={4}
                            className="min-w-44"
                          >
                            <DropdownMenuItem onClick={handleCopyChatMarkdown}>
                              <CopyIcon className="size-3.5" />
                              Copy markdown
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={handleExportChat}>
                              <FileDown className="size-3.5" />
                              Export as .md
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuPortal>
                      </DropdownMenuSub>
                      <DropdownMenuItem
                        onClick={handleDeleteChat}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {selectedFile === null && selectedSpaceFile === null && selectedArtifact === null && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handleToggleCowork}
                          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <PanelRight className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isCoworkPanelOpen ? "Hide side panel" : "Open side panel"}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
              {activeMcpHostName && (
                <div className="mx-4 mt-1 flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                  <span aria-hidden="true">⚡</span>
                  <span>
                    Started by{" "}
                    <span className="font-medium text-foreground">
                      {activeMcpHostName}
                    </span>{" "}
                    via MCP. This conversation isn't in your sidebar — it
                    lives in Settings → MCP Server → Activity.
                  </span>
                </div>
              )}
              <ChatView
                key={activeConversationId}
                conversationId={activeConversationId}
                spaceId={activeSpaceId}
                onNewConversation={handleNewConversation}
                showHeader={false}
                className="flex-1 min-h-0"
                initialInput={initialInput}
              />
            </main>
          }
        />
        </FileSelectionContext.Provider>
      ) : (
        <main className="flex-1 min-w-0 h-screen flex flex-col">
          <LandingPage
            space={activeSpace}
            spaceId={activeSpaceId}
            tabCount={allActiveTabs.length}
            pinnedCount={pinnedCount}
            onNewConversation={handleNewConversation}
            initialInput={initialInput}
            refocusOnWindowFocus={surface === "newtab"}
          />
        </main>
      )}

      {showOverlay && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[20vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowOverlay(false);
          }}
        >
          <iframe
            ref={overlayIframeRef}
            src={chrome.runtime.getURL(
              `/overlay.html${overlayAction ? `?action=${overlayAction}` : ""}`,
            )}
            className="w-[580px] max-w-[90vw] max-h-[70vh] border-none rounded-lg"
            onLoad={(e) => (e.currentTarget as HTMLIFrameElement).focus()}
          />
        </div>
      )}
      {/* Rename dialog */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmRename();
            }}
            onKeyDown={(e) => {
              if (e.metaKey && e.key === "Enter" && renameValue.trim()) {
                e.preventDefault();
                confirmRename();
              }
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              placeholder="Chat title"
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()} data-action="">
                Save
                <Kbd className="ml-1.5">
                  <span>⌘</span>
                  <span>↵</span>
                </Kbd>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent
          onKeyDown={(e) => {
            if (e.metaKey && e.key === "Enter") {
              e.preventDefault();
              confirmDelete();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.title}&rdquo;.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
              <Kbd className="ml-1.5">
                <span>⌘</span>
                <span>↵</span>
              </Kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Available model strings ("<provider>:<model>") for the schedule dialog:
 * the user's favorite models plus the currently-selected agent model.
 */
function useScheduleModels(): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      const s = await storage.getSettings();
      const a = await storage.getAgentSettings();
      const list = new Set<string>(s.favoriteModels ?? []);
      if (a.agentModel) list.add(a.agentModel);
      setModels([...list]);
    })();
  }, []);
  return models;
}
