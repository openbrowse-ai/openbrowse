import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { OPFS } from "@/lib/vfs/opfs";
import { classifyFile, isBinaryClass } from "@/lib/vfs/file-classify";
import { Markdown } from "@/components/chat/Markdown";
import { CodeViewer } from "@/components/chat/CodeViewer";
import { SheetViewer } from "@/components/chat/SheetViewer";
import { JsonViewer } from "@/components/chat/JsonViewer";
import { HtmlPreview } from "@/components/chat/HtmlPreview";
import { MediaPlayer } from "@/components/chat/MediaPlayer";
import { Copy, Check, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadBlob, downloadText } from "@/lib/download";

interface FileViewerModalProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
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

export function FileViewerModal({ filePath, fileName, onClose }: FileViewerModalProps) {
  const fileClass = useMemo(() => classifyFile(fileName), [fileName]);
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const isBinary = isBinaryClass(fileClass);

  const [loaded, setLoaded] = useState<LoadedContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
  }, [filePath, isBinary]);

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

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-4xl sm:max-w-4xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted/30">
          <DialogTitle
            className="text-sm font-mono truncate min-w-0 flex-1 text-foreground/90"
            title={filePath}
          >
            {fileName}
          </DialogTitle>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              disabled={loaded === null}
              className="h-7 px-2 text-xs gap-1.5"
              title="Download file"
            >
              <Download className="size-3.5" />
              Download
            </Button>
            {!isBinary && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                disabled={loaded?.text === undefined}
                className="h-7 px-2 text-xs gap-1.5"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" className="size-7">
                <X className="size-4" />
                <span className="sr-only">Close</span>
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto bg-background min-h-0 flex flex-col">
          {error ? (
            <div className="p-6 text-destructive text-sm">
              Failed to load file: {error}
            </div>
          ) : loaded === null ? (
            <div className="p-6 text-muted-foreground text-sm">Loading…</div>
          ) : fileClass === "image" && loaded.blobUrl ? (
            <div className="flex items-center justify-center p-6 bg-muted/20 min-h-full">
              <img
                src={loaded.blobUrl}
                alt={fileName}
                className="max-w-full max-h-[70vh] object-contain"
              />
            </div>
          ) : fileClass === "pdf" && loaded.blobUrl ? (
            <iframe
              src={loaded.blobUrl}
              title={fileName}
              className="w-full h-[75vh] border-0"
            />
          ) : fileClass === "sheet" && loaded.blob ? (
            <SheetViewer blob={loaded.blob} fileName={fileName} />
          ) : fileClass === "audio" && loaded.blobUrl ? (
            <MediaPlayer blobUrl={loaded.blobUrl} fileName={fileName} kind="audio" />
          ) : fileClass === "video" && loaded.blobUrl ? (
            <MediaPlayer blobUrl={loaded.blobUrl} fileName={fileName} kind="video" />
          ) : fileClass === "binary" && loaded.blob ? (
            <div className="flex flex-col items-center justify-center p-10 gap-2 text-center">
              <span className="text-sm text-muted-foreground">
                Binary file — preview not available
              </span>
              <span className="text-xs text-muted-foreground/70 font-mono">
                {formatBytes(loaded.blob.size)}
              </span>
            </div>
          ) : fileClass === "json" && loaded.text !== undefined ? (
            <JsonViewer text={loaded.text} fileName={fileName} />
          ) : fileClass === "html" && loaded.text !== undefined ? (
            <HtmlPreview text={loaded.text} fileName={fileName} />
          ) : fileClass === "markdown" && loaded.text !== undefined ? (
            <div className="p-6">
              <Markdown source={loaded.text} />
            </div>
          ) : loaded.text !== undefined ? (
            <CodeViewer
              code={loaded.text}
              language={language}
              className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
