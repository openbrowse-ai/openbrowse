import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { OPFS } from "@/lib/vfs/opfs";
import { Markdown } from "@/components/chat/Markdown";
import { CodeViewer } from "@/components/chat/CodeViewer";
import { Copy, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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

export function FileViewerModal({ filePath, fileName, onClose }: FileViewerModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const text = await OPFS.readFile(filePath);
        if (!cancelled) setContent(text);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleCopy = async () => {
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isMarkdown = fileName.endsWith(".md");
  const isImage = /\.(png|jpe?g|svg|gif|webp)$/i.test(fileName);
  const language = useMemo(() => detectLanguage(fileName), [fileName]);

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
              onClick={handleCopy}
              disabled={!content}
              className="h-7 px-2 text-xs gap-1.5"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" className="size-7">
                <X className="size-4" />
                <span className="sr-only">Close</span>
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto bg-background">
          {error ? (
            <div className="p-6 text-destructive text-sm">
              Failed to load file: {error}
            </div>
          ) : content === null && !isImage ? (
            <div className="p-6 text-muted-foreground text-sm">Loading…</div>
          ) : isImage ? (
            <div className="flex items-center justify-center p-10">
              <span className="text-sm text-muted-foreground">
                Image preview not supported yet
              </span>
            </div>
          ) : isMarkdown ? (
            <div className="p-6">
              <Markdown source={content!} />
            </div>
          ) : (
            <CodeViewer
              code={content!}
              language={language}
              className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
