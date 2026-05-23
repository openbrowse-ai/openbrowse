import { useState, useEffect, useMemo, useCallback } from "react";
import { OPFS } from "@/lib/vfs/opfs";
import { classifyFile, isBinaryClass } from "@/lib/vfs/file-classify";
import { Markdown } from "@/components/chat/Markdown";
import { CodeViewer } from "@/components/chat/CodeViewer";
import { SheetViewer } from "@/components/chat/SheetViewer";
import {
  JsonViewer,
  type JsonViewerMode,
  type ParseMeta as JsonParseMeta,
} from "@/components/chat/JsonViewer";
import {
  HtmlPreview,
  type HtmlPreviewMode,
} from "@/components/chat/HtmlPreview";
import { MediaPlayer } from "@/components/chat/MediaPlayer";
import {
  Copy,
  Check,
  X,
  Download,
  RefreshCw,
  FileIcon,
  Eye,
  Code as CodeIcon,
  ListTree,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadBlob, downloadText } from "@/lib/download";
import { cn } from "@/lib/utils";

interface FileViewerPanelProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface LoadedContent {
  text?: string;
  blob?: Blob;
  blobUrl?: string;
}

export function FileViewerPanel({
  filePath,
  fileName,
  onClose,
  className,
}: FileViewerPanelProps) {
  const fileClass = useMemo(() => classifyFile(fileName), [fileName]);
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const isBinary = isBinaryClass(fileClass);
  const typeLabel = useMemo(() => uppercaseExt(fileName), [fileName]);

  const [loaded, setLoaded] = useState<LoadedContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Per-viewer modes — owned here so the toolbar can drive them.
  const [htmlMode, setHtmlMode] = useState<HtmlPreviewMode>("preview");
  const [jsonMode, setJsonMode] = useState<JsonViewerMode>("tree");
  const [jsonMeta, setJsonMeta] = useState<JsonParseMeta | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoaded(null);
    setError(null);
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

  const onJsonMeta = useCallback((m: JsonParseMeta) => setJsonMeta(m), []);

  return (
    <div className={cn("flex flex-col h-full min-h-0 bg-background", className)}>
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
            title="Refresh from disk"
          >
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton
            onClick={handleDownload}
            disabled={loaded === null}
            title="Download"
          >
            <Download className="size-3.5" />
          </IconButton>
          {!isBinary && (
            <IconButton
              onClick={handleCopy}
              disabled={loaded?.text === undefined}
              title="Copy contents"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </IconButton>
          )}
          <IconButton onClick={onClose} title="Close">
            <X className="size-4" />
          </IconButton>
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
          <div className="flex items-center justify-center p-6 bg-muted/20 flex-1 min-h-0 overflow-auto">
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
          <div className="flex-1 overflow-auto p-6">
            <Markdown source={loaded.text} />
          </div>
        ) : loaded.text !== undefined ? (
          <div className="flex-1 overflow-auto">
            <CodeViewer
              code={loaded.text}
              language={language}
              className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
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
  title: string;
  children: React.ReactNode;
}

function IconButton({ onClick, disabled, title, children }: IconButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      className="size-7 text-muted-foreground hover:text-foreground"
      title={title}
      aria-label={title}
    >
      {children}
    </Button>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

interface SegmentedToggleProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  disabledValues?: T[];
}

function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
  disabledValues,
}: SegmentedToggleProps<T>) {
  return (
    <div className="inline-flex items-center rounded-md bg-muted p-0.5">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === value;
        const disabled = disabledValues?.includes(opt.value) ?? false;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "h-6 px-2 rounded-sm flex items-center gap-1 text-[11px] font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "opacity-50 cursor-not-allowed",
            )}
            title={opt.label}
            aria-label={opt.label}
            aria-pressed={active}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
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
      <Button size="sm" variant="secondary" onClick={onDownload} className="mt-2">
        <Download className="size-3.5" />
        Download
      </Button>
    </div>
  );
}
