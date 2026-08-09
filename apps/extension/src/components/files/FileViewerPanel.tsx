import { CodeViewer } from "@/components/chat/CodeViewer";
import {
  HtmlPreview,
  type HtmlPreviewMode,
} from "@/components/chat/HtmlPreview";
import {
  JsonViewer,
  type ParseMeta as JsonParseMeta,
  type JsonViewerMode,
} from "@/components/chat/JsonViewer";
import { Markdown } from "@/components/chat/Markdown";
import { linkifyMemoryMarkdown } from "@/lib/memory/linkify";
import { MediaPlayer } from "@/components/chat/MediaPlayer";
import { SheetViewer } from "@/components/chat/SheetViewer";
import { Button } from "@/components/ui/button";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { downloadBlob, downloadText } from "@/lib/download";
import { formatBytes } from "@/lib/format-bytes";
import { saveToSpace } from "@/lib/spaces/save-to-space";
import {
  savedFilesDb,
  savedFilesEvents,
  sha256Hex,
  type SavedStatus,
} from "@/lib/spaces/saved-files-db";
import { cn } from "@/lib/utils";
import { vfsEvents } from "@/lib/vfs/events";
import { classifyFile, isBinaryClass } from "@/lib/vfs/file-classify";
import { OPFS } from "@/lib/vfs/opfs";
import {
  Check,
  Code as CodeIcon,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCheck,
  FileClock,
  FileIcon,
  FilePlusCorner,
  ListTree,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface FileViewerPanelProps {
  filePath: string;
  fileName: string;
  /**
   * The owning conversation id. Used to derive the workspace-relative path
   * from `filePath` and to look up / record saved-to-space relationships.
   * Optional so tooling that mounts the viewer outside the home/sidepanel
   * (e.g. ad-hoc previews) keeps working — when omitted, the save-to-space
   * affordance is not rendered.
   */
  conversationId?: string;
  /**
   * The active space id, or `null` when the user is in the global scope.
   * When omitted or null, the save-to-space button is rendered disabled
   * with an explanatory tooltip (matching the Working Folder card).
   */
  spaceId?: string | null;
  /**
   * When true, renders an "Open in new tab" action that opens this same file
   * in the standalone `file.html` viewer tab. Off by default; enabled by
   * surfaces (e.g. the Space file rail) where popping the file out to its own
   * tab is useful. The standalone tab itself omits this so it doesn't offer
   * to re-open a copy of itself.
   */
  openInNewTab?: boolean;
  onClose: () => void;
  /**
   * Whether to render the Close (X) action. Default true. Surfaces that keep a
   * persistent list next to the viewer (e.g. the Settings memory master/detail,
   * where you switch files via the tree and there's nothing to return to) can
   * set this false to drop a redundant control.
   */
  showClose?: boolean;
  /**
   * Optional extra action(s) rendered in the header's action row, just before
   * the Close button. Lets a host add file-specific actions (e.g. a Delete
   * button, with its own confirmation) without this component needing to know
   * their semantics. Keeps the header single-row instead of the host stacking
   * a second bar above the viewer.
   */
  headerActions?: React.ReactNode;
  /**
   * Optional block rendered at the top of the markdown body, above the
   * rendered content and inside the same scroll area. Lets a host surface
   * parsed metadata (e.g. a memory file's frontmatter title/description) the
   * way the Skills tab shows a skill's description. Only rendered for markdown.
   */
  contentHeader?: React.ReactNode;
  /**
   * When provided, `[[wikilink]]` spans in the markdown body render as clickable
   * links; clicking one calls this with the bare link name (basename). Lets a
   * host (e.g. the memory viewer) navigate between linked notes. Only affects
   * markdown rendering.
   */
  onWikiLink?: (name: string) => void;
  /**
   * When provided, `[[chat:<conversationId>]]` spans render as clickable links;
   * clicking one calls this with the conversation id. Lets a host navigate to
   * the conversation a remembered fact came from. Only affects markdown
   * rendering.
   */
  onChatLink?: (conversationId: string) => void;
  className?: string;
}

/** Map a file extension to a Shiki language identifier. */
function detectLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "jsonc",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    sql: "sql",
    md: "markdown",
    mdx: "mdx",
    txt: "text",
  };
  return map[ext] ?? "text";
}

function uppercaseExt(fileName: string): string {
  const ext = fileName.split(".").pop();
  return ext ? ext.toUpperCase() : "FILE";
}

/**
 * Strip a leading YAML frontmatter block so it doesn't render as a stray
 * setext heading (the trailing `---` turns the preceding lines into an H2)
 * or a fenced block in the markdown preview. Mirrors the skills viewer. The
 * raw source (including frontmatter) is still available via Copy / Download.
 */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : md;
}

interface LoadedContent {
  text?: string;
  blob?: Blob;
  blobUrl?: string;
}

/**
 * Strip the conversations workspace prefix from a full OPFS path to get the
 * workspace-relative path used by the saved-files-db key. Returns null when
 * `filePath` doesn't live under a conversation workspace (the save-to-space
 * affordance is hidden in that case).
 */
function relativeFilePathFor(
  filePath: string,
  conversationId: string,
): string | null {
  const prefix = `conversations/${conversationId}/workspace/`;
  if (!filePath.startsWith(prefix)) return null;
  return filePath.slice(prefix.length);
}

export function FileViewerPanel({
  filePath,
  fileName,
  conversationId,
  spaceId,
  openInNewTab = false,
  onClose,
  showClose = true,
  headerActions,
  contentHeader,
  onWikiLink,
  onChatLink,
  className,
}: FileViewerPanelProps) {
  const fileClass = useMemo(() => classifyFile(fileName), [fileName]);
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const isBinary = isBinaryClass(fileClass);
  const typeLabel = useMemo(() => uppercaseExt(fileName), [fileName]);

  const relativeFilePath = useMemo(
    () =>
      conversationId ? relativeFilePathFor(filePath, conversationId) : null,
    [filePath, conversationId],
  );
  const canSaveToSpace = conversationId != null && relativeFilePath != null;
  const activeSpaceId = spaceId ?? null;

  const [loaded, setLoaded] = useState<LoadedContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Per-viewer modes — owned here so the toolbar can drive them.
  const [htmlMode, setHtmlMode] = useState<HtmlPreviewMode>("preview");
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">(
    "preview",
  );
  const [jsonMode, setJsonMode] = useState<JsonViewerMode>("tree");
  const [jsonMeta, setJsonMeta] = useState<JsonParseMeta | null>(null);

  // Saved-to-space relationship state. Computed from the loaded source's
  // size + hash plus the saved-files-db record. Recomputes whenever the
  // file content changes (vfs:change → reload → new hash) or whenever the
  // save record itself changes (other surfaces save the same file).
  const [savedStatus, setSavedStatus] = useState<SavedStatus>({
    state: "unsaved",
  });
  const [savingToSpace, setSavingToSpace] = useState(false);

  // Reset per-file UI state when the file changes.
  useEffect(() => {
    setHtmlMode("preview");
    setJsonMode("tree");
    setJsonMeta(null);
    setRefreshKey(0);
  }, [filePath]);

  // Auto-flip JSON to Raw when the document fails to parse.
  useEffect(() => {
    if (jsonMeta?.hasError) setJsonMode("raw");
  }, [jsonMeta?.hasError]);

  // Path that `loaded` currently holds content for. A *same-file* reload
  // (vfs:change, visibility catch-up, manual refresh) can then swap text in
  // place instead of blanking the pane, so a live-updating file doesn't flash
  // on every write. Binary reloads still blank, because the effect cleanup
  // revokes the previous blob URL before the replacement resolves.
  const loadedPathRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    const isSameFileTextReload =
      !isBinary && loadedPathRef.current === filePath;
    if (!isSameFileTextReload) {
      loadedPathRef.current = null;
    setLoaded(null);
    setError(null);
    }
    async function load() {
      try {
        if (isBinary) {
          const blob = await OPFS.readFileBytes(filePath);
          if (cancelled) return;
          createdUrl = URL.createObjectURL(blob);
          setLoaded({ blob, blobUrl: createdUrl });
        } else {
          const text = await OPFS.readFile(filePath);
          if (cancelled) return;
          setLoaded({ text });
        }
        loadedPathRef.current = filePath;
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [filePath, isBinary, refreshKey]);

  // Auto-refresh when the agent rewrites the file we're viewing. `vfsEvents`
  // is bridged across extension contexts, so a write from the service worker
  // (agent run) or another tab lands here. Debounced so a script that writes
  // the same file repeatedly only triggers one re-load per quiet period.
  //
  // The visibility pass is a catch-up for a background tab that was frozen or
  // throttled while the change was broadcast: re-read on the way back to
  // visible so the user never reads stale content.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const scheduleRefresh = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        setRefreshKey((k) => k + 1);
      }, 200);
    };
    const onVfsChange = (e: Event) => {
      const { path } = (e as CustomEvent).detail ?? {};
      if (path !== filePath) return;
      scheduleRefresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    vfsEvents.addEventListener("vfs:change", onVfsChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      vfsEvents.removeEventListener("vfs:change", onVfsChange);
      document.removeEventListener("visibilitychange", onVisible);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [filePath]);

  // Compute the saved-to-space status whenever the file content or the
  // saved-files-db relationship changes. Reads source bytes from the
  // already-loaded `loaded` state when possible (text files share the
  // string with the viewer; binary files re-read the blob since hashing
  // wants the bytes anyway). Skipped entirely when the affordance isn't
  // applicable (no conversationId, or filePath isn't a workspace path).
  const refreshSavedStatus = useCallback(async () => {
    if (!canSaveToSpace || conversationId == null || relativeFilePath == null) {
      setSavedStatus({ state: "unsaved" });
      return;
    }
    if (loaded == null) return; // wait until the source is loaded
    try {
      let bytes: Blob;
      if (loaded.blob) {
        bytes = loaded.blob;
      } else if (loaded.text !== undefined) {
        bytes = new Blob([loaded.text]);
      } else {
        return;
      }
      const sourceSize = bytes.size;
      const sourceHashHex = await sha256Hex(bytes);
      const status = await savedFilesDb.getStatus({
        conversationId,
        filePath: relativeFilePath,
        spaceId: activeSpaceId,
        currentSourceSize: sourceSize,
        currentSourceHashHex: sourceHashHex,
      });
      setSavedStatus(status);
    } catch {
      // Hashing or IDB failed; leave the prior status in place rather than
      // flipping the indicator to a misleading state.
    }
  }, [canSaveToSpace, conversationId, relativeFilePath, activeSpaceId, loaded]);

  useEffect(() => {
    void refreshSavedStatus();
  }, [refreshSavedStatus]);

  // Subscribe to saved-files-db changes so a save performed in the
  // working-folder rail (or another window) updates the indicator without
  // a full re-mount.
  useEffect(() => {
    if (!canSaveToSpace) return;
    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail ?? {};
      // Filter on the relationship we care about. A filePath/conversationId
      // mismatch means it's a different file's save record changing.
      if (
        detail.conversationId != null &&
        detail.conversationId !== conversationId
      ) {
        return;
      }
      if (detail.filePath != null && detail.filePath !== relativeFilePath) {
        return;
      }
      void refreshSavedStatus();
    }
    savedFilesEvents.addEventListener("saved-files:changed", onChange);
    return () =>
      savedFilesEvents.removeEventListener("saved-files:changed", onChange);
  }, [canSaveToSpace, conversationId, relativeFilePath, refreshSavedStatus]);

  const handleCopy = async () => {
    if (loaded?.text === undefined) return;
    await navigator.clipboard.writeText(loaded.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!loaded) return;
    if (loaded.blob) {
      downloadBlob(loaded.blob, fileName);
      return;
    }
    if (loaded.text !== undefined) {
      downloadText(loaded.text, fileName);
    }
  };

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1);
  };

  const handleOpenInNewTab = () => {
    chrome.tabs
      .create({
        url: chrome.runtime.getURL(
          `file.html?path=${encodeURIComponent(filePath)}&name=${encodeURIComponent(fileName)}`,
        ),
      })
      .catch(() => {
        toast.error(`Couldn't open "${fileName}" in a new tab`);
      });
  };

  const handleSaveToSpace = async () => {
    if (
      !conversationId ||
      !relativeFilePath ||
      !activeSpaceId ||
      savingToSpace
    ) {
      return;
    }
    setSavingToSpace(true);
    try {
      const result = await saveToSpace({
        conversationId,
        spaceId: activeSpaceId,
        filePath: relativeFilePath,
      });
      if (result.ok) {
        toast.success(
          result.mode === "updated"
            ? `Updated "${fileName}" in this space`
            : `Saved "${fileName}" to this space`,
        );
        // savedFilesDb broadcasts; the listener above will re-fetch and
        // flip the indicator. No local optimistic update needed.
      } else {
        toast.error(`Save failed: ${result.error}`);
      }
    } finally {
      setSavingToSpace(false);
    }
  };

  const onJsonMeta = useCallback((m: JsonParseMeta) => setJsonMeta(m), []);

  return (
    <div
      className={cn("flex flex-col h-full min-h-0 bg-background", className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30 shrink-0">
        {/* Left: filename + type badge */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className="text-sm font-mono truncate text-foreground/90"
            title={filePath}
          >
            {fileName}
          </span>
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider bg-muted text-muted-foreground">
            {typeLabel}
          </span>
          {/* JSON record count surfaced in the header */}
          {fileClass === "json" && jsonMeta?.lineCount != null && (
            <span className="shrink-0 text-[11px] text-muted-foreground font-mono whitespace-nowrap">
              {jsonMeta.lineCount.toLocaleString()} record
              {jsonMeta.lineCount === 1 ? "" : "s"}
            </span>
          )}
          {fileClass === "json" && jsonMeta?.errorBanner && (
            <span
              className="shrink min-w-0 truncate text-[11px] text-destructive"
              title={jsonMeta.errorBanner}
            >
              {jsonMeta.errorBanner}
            </span>
          )}
        </div>

        {/* Center: viewer-specific controls */}
        <div className="flex items-center gap-1 shrink-0">
          {fileClass === "html" && (
            <SegmentedToggle
              value={htmlMode}
              onChange={setHtmlMode}
              options={[
                { value: "preview", icon: Eye, label: "Preview" },
                { value: "source", icon: CodeIcon, label: "Source" },
              ]}
            />
          )}
          {fileClass === "markdown" && (
            <SegmentedToggle
              value={markdownMode}
              onChange={setMarkdownMode}
              options={[
                { value: "preview", icon: Eye, label: "Rendered" },
                { value: "source", icon: CodeIcon, label: "Source" },
              ]}
            />
          )}
          {fileClass === "json" && (
            <SegmentedToggle
              value={jsonMode}
              onChange={setJsonMode}
              disabledValues={jsonMeta?.hasError ? ["tree"] : undefined}
              options={[
                { value: "tree", icon: ListTree, label: "Tree" },
                { value: "raw", icon: CodeIcon, label: "Raw" },
              ]}
            />
          )}
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            onClick={handleRefresh}
            disabled={loaded === null}
            tooltip="Refresh file content"
          >
            <RefreshCw className="size-3.5" />
          </IconButton>
          {canSaveToSpace && (
            <SaveToSpaceButton
              status={savedStatus}
              spaceActive={activeSpaceId !== null}
              loading={savingToSpace}
              disabled={loaded === null}
              onClick={handleSaveToSpace}
            />
          )}
          {openInNewTab && (
            <IconButton onClick={handleOpenInNewTab} tooltip="Open in new tab">
              <ExternalLink className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            onClick={handleDownload}
            disabled={loaded === null}
            tooltip="Download file"
          >
            <Download className="size-3.5" />
          </IconButton>
          {!isBinary && (
            <IconButton
              onClick={handleCopy}
              disabled={loaded?.text === undefined}
              tooltip={copied ? "Copied" : "Copy contents"}
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </IconButton>
          )}
          {headerActions}
          {showClose && (
          <IconButton onClick={onClose} tooltip="Close file">
            <X className="size-4" />
          </IconButton>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden bg-background flex flex-col min-h-0">
        {error ? (
          <div className="p-6 text-destructive text-sm">
            Failed to load file: {error}
          </div>
        ) : loaded === null ? (
          <div className="p-6 text-muted-foreground text-sm">Loading…</div>
        ) : fileClass === "image" && loaded.blobUrl ? (
          <div className="flex items-center justify-center p-6 bg-muted/20 flex-1 min-h-0">
            <img
              src={loaded.blobUrl}
              alt={fileName}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : fileClass === "pdf" && loaded.blobUrl ? (
          <iframe
            src={loaded.blobUrl}
            title={fileName}
            className="w-full flex-1 border-0"
          />
        ) : fileClass === "sheet" && loaded.blob ? (
          <SheetViewer blob={loaded.blob} fileName={fileName} />
        ) : fileClass === "audio" && loaded.blobUrl ? (
          <MediaPlayer
            blobUrl={loaded.blobUrl}
            fileName={fileName}
            kind="audio"
          />
        ) : fileClass === "video" && loaded.blobUrl ? (
          <MediaPlayer
            blobUrl={loaded.blobUrl}
            fileName={fileName}
            kind="video"
          />
        ) : fileClass === "binary" && loaded.blob ? (
          <BinaryDownloadStub
            fileName={fileName}
            typeLabel={typeLabel}
            sizeLabel={formatBytes(loaded.blob.size)}
            onDownload={handleDownload}
          />
        ) : fileClass === "json" && loaded.text !== undefined ? (
          <JsonViewer
            text={loaded.text}
            fileName={fileName}
            mode={jsonMode}
            onParseMeta={onJsonMeta}
          />
        ) : fileClass === "html" && loaded.text !== undefined ? (
          <HtmlPreview text={loaded.text} fileName={fileName} mode={htmlMode} />
        ) : fileClass === "markdown" && loaded.text !== undefined ? (
          markdownMode === "source" ? (
            // Source shows the file verbatim, frontmatter included.
            <div className="flex-1 overflow-auto">
              <CodeViewer
                code={loaded.text}
                language={language}
                className="text-sm leading-relaxed [&_pre]:m-0! [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
              />
            </div>
          ) : (
          <div className="flex-1 overflow-auto p-6">
              {contentHeader}
              <Markdown
                source={
                  // The memory pre-pass (note links, source-chat links, bare
                  // URL citations) only applies to memory surfaces — signalled
                  // by either in-app link handler being wired. Plain file
                  // previews render verbatim.
                  onWikiLink || onChatLink
                    ? linkifyMemoryMarkdown(stripFrontmatter(loaded.text))
                    : stripFrontmatter(loaded.text)
                }
                onWikiLink={onWikiLink}
                onChatLink={onChatLink}
              />
          </div>
          )
        ) : loaded.text !== undefined ? (
          <div className="flex-1 overflow-auto">
            <CodeViewer
              code={loaded.text}
              language={language}
              className="text-sm leading-relaxed [&_pre]:m-0! [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────── Helpers ─────────────────────────

interface IconButtonProps {
  onClick: () => void;
  disabled?: boolean;
  tooltip: string;
  children: React.ReactNode;
}

function IconButton({ onClick, disabled, tooltip, children }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={tooltip}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface SaveToSpaceButtonProps {
  status: SavedStatus;
  spaceActive: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}

/**
 * Three-state save-to-space affordance.
 *
 *   unsaved → neutral icon, "Save to space"
 *   saved   → emerald check, "Saved to space"
 *   stale   → amber clock, "Source has changed since save — click to update"
 *
 * Disabled (with explanatory tooltip) when no space is active.
 */
function SaveToSpaceButton({
  status,
  spaceActive,
  loading,
  disabled,
  onClick,
}: SaveToSpaceButtonProps) {
  let icon: React.ReactNode;
  let tooltip: string;
  let colorClass = "text-muted-foreground";

  if (!spaceActive) {
    icon = <FilePlusCorner className="size-3.5" />;
    tooltip = "Open this conversation in a space to enable Save to space";
  } else if (status.state === "saved") {
    icon = <FileCheck className="size-3.5" />;
    tooltip = "Saved to space";
    colorClass = "text-emerald-500";
  } else if (status.state === "stale") {
    icon = <FileClock className="size-3.5" />;
    tooltip = "Source has changed since the last save — click to update";
    colorClass = "text-amber-500";
  } else {
    icon = <FilePlusCorner className="size-3.5" />;
    tooltip = "Save to space";
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={!spaceActive || disabled || loading}
          className={cn("size-7 hover:text-foreground", colorClass)}
          aria-label={tooltip}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface BinaryDownloadStubProps {
  fileName: string;
  typeLabel: string;
  sizeLabel: string;
  onDownload: () => void;
}

/**
 * Empty-state body for unviewable binary files. Mirrors Claude desktop's
 * "Click to open file" card: large file icon, name, type, size, single
 * primary action.
 */
function BinaryDownloadStub({
  fileName,
  typeLabel,
  sizeLabel,
  onDownload,
}: BinaryDownloadStubProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 p-10 text-center">
      <FileIcon
        className="size-16 text-muted-foreground/60"
        strokeWidth={1.25}
      />
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-base font-medium text-foreground">
          {fileName}
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          {typeLabel} · {sizeLabel}
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={onDownload}
        className="mt-2"
      >
        <Download className="size-3.5" />
        Download
      </Button>
    </div>
  );
}
