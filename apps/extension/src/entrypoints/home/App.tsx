import { ChatView } from "@/components/chat/ChatView";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActiveTabs } from "@/hooks/useActiveTabs";
import { useTheme } from "@/hooks/useTheme";
import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Download,
  MoreVertical,
  PanelRight,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CoworkPanel } from "./components/CoworkPanel";
import { HomeSidebar } from "./components/HomeSidebar";
import { LandingPage } from "./components/LandingPage";

export default function App() {
  useTheme();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(() => {
    const hash = window.location.hash.slice(1);
    return hash || null;
  });
  // Prefill consumed once on mount — used by the "Try in chat" flow from
  // Settings. Reading from URL synchronously avoids a flicker, and we
  // history.replaceState the param away so a refresh doesn't re-seed.
  const [initialInput] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    const prefill = params.get("prefill");
    if (!prefill) return undefined;
    // Strip the param from the URL without disturbing the hash (which
    // carries the active conversation id).
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

  const [conversationTitle, setConversationTitle] = useState<string | null>(
    null,
  );
  const [isCoworkPanelOpen, setIsCoworkPanelOpen] = useState(true);
  const [generatingTitleIds, setGeneratingTitleIds] = useState<Set<string>>(
    new Set(),
  );
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) ?? null;
  const allActiveTabs = useActiveTabs(activeSpace?.windowId ?? null);
  const pinnedCount = allActiveTabs.filter((t) => t.pinned).length;

  useEffect(() => {
    async function init() {
      const allSpaces = await storage.getSpaces();
      setSpaces(allSpaces);

      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow.id) {
        const space = allSpaces.find((s) => s.windowId === currentWindow.id);
        if (space) {
          setActiveSpaceId(space.id);
        } else if (allSpaces.length > 0) {
          setActiveSpaceId(allSpaces[0].id);
        }
      }
    }
    init();

    const listener = () => {
      init();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

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
    if (!activeSpace) return;
    document.title = `${activeSpace.name} — OpenBrowse`;

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
  }, [activeSpace]);

  useEffect(() => {
    const hash = activeConversationId ? `#${activeConversationId}` : "";
    if (window.location.hash !== hash) {
      history.replaceState(null, "", hash || window.location.pathname);
    }
  }, [activeConversationId]);

  useEffect(() => {
    const onHashChange = () => {
      const id = window.location.hash.slice(1) || null;
      setActiveConversationId(id);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setConversationTitle(null);
      return;
    }
    setIsCoworkPanelOpen(true);
    chatDb.getConversation(activeConversationId).then((conv) => {
      setConversationTitle(conv?.title ?? null);
    });
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

  const handleExportChat = useCallback(async () => {
    if (!activeConversationId) return;
    const [conv, messages] = await Promise.all([
      chatDb.getConversation(activeConversationId),
      chatDb.getMessages(activeConversationId),
    ]);
    const lines = messages
      .map((m) => {
        const role = m.role === "user" ? "You" : "Assistant";
        const partTexts: string[] = [];
        for (const part of m.parts) {
          if (part.type === "text" && part.text.trim()) {
            partTexts.push(part.text);
          } else if (part.type === "dynamic-tool") {
            const toolLine = `**Tool: ${part.toolName}**`;
            if (part.output) {
              partTexts.push(
                `${toolLine}\n\n\`\`\`\n${typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2)}\n\`\`\``,
              );
            } else {
              partTexts.push(toolLine);
            }
          }
        }
        if (partTexts.length === 0) return null;
        return `## ${role}\n\n${partTexts.join("\n\n")}`;
      })
      .filter(Boolean);
    const markdown = `# ${conv?.title ?? "Chat"}\n\n${lines.join("\n\n---\n\n")}`;
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${conv?.title ?? "chat"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeConversationId]);

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
    await chatDb.deleteConversation(deleteTarget.id);
    if (deleteTarget.id === activeConversationId) {
      setActiveConversationId(null);
    }
    setDeleteTarget(null);
  }, [deleteTarget, activeConversationId]);

  const handleNewConversation = useCallback((id: string) => {
    if (id) {
      setActiveConversationId(id);
    } else {
      setActiveConversationId(null);
    }
  }, []);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  return (
    <div className="flex h-screen bg-[var(--background)]">
      <HomeSidebar
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={() => handleNewConversation("")}
        onGoHome={() => setActiveConversationId(null)}
        onOpenOverlay={() => setShowOverlay(true)}
        onNewSpace={() => {
          setOverlayAction("new-space");
          setShowOverlay(true);
        }}
        onConfigureSpace={() => {
          setOverlayAction("configure-space");
          setShowOverlay(true);
        }}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
      />

      <main className="flex-1 min-w-0 h-screen flex flex-col">
        {activeConversationId && (
          <div className="sticky top-0 z-10 flex items-center justify-between px-4 pt-2 pb-px bg-background/80 backdrop-blur-md after:absolute after:inset-x-0 after:-bottom-6 after:h-6 after:bg-linear-to-b after:from-background after:to-transparent after:pointer-events-none">
            <span
              className={`text-sm font-medium truncate min-w-0 ${activeConversationId && generatingTitleIds.has(activeConversationId) ? "shimmer-text" : ""}`}
            >
              {conversationTitle ?? "New conversation"}
            </span>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <MoreVertical className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleRenameChat}>
                    <Pencil className="size-3.5" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportChat}>
                    <Download className="size-3.5" />
                    Export chat
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleDeleteChat}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setIsCoworkPanelOpen(!isCoworkPanelOpen)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <PanelRight className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Open side panel</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
        {activeConversationId ? (
          <ChatView
            key={activeConversationId}
            conversationId={activeConversationId}
            spaceId={activeSpaceId}
            onNewConversation={handleNewConversation}
            showHeader={false}
            className="flex-1 min-h-0"
            initialInput={initialInput}
          />
        ) : (
          <LandingPage
            space={activeSpace}
            spaceId={activeSpaceId}
            tabCount={allActiveTabs.length}
            pinnedCount={pinnedCount}
            onNewConversation={handleNewConversation}
            initialInput={initialInput}
          />
        )}
      </main>

      {activeConversationId && (
        <aside
          className={cn(
            "h-screen shrink-0 overflow-hidden bg-[var(--background)] transition-[width] duration-300 ease-in-out",
            isCoworkPanelOpen ? "w-[340px]" : "w-0",
          )}
        >
          <div className="h-full w-[340px]">
            <CoworkPanel conversationId={activeConversationId} />
          </div>
        </aside>
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
              <Button type="submit" disabled={!renameValue.trim()}>
                Save
                <kbd className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] opacity-60">
                  <span>⌘</span>
                  <span>↵</span>
                </kbd>
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
              <kbd className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] opacity-60">
                <span>⌘</span>
                <span>↵</span>
              </kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
