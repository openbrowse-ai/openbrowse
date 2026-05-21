import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OPFS } from "@/lib/vfs/opfs";
import { Markdown } from "@/components/chat/Markdown";
import { Copy, Check } from "lucide-react";

interface FileViewerModalProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

export function FileViewerModal({ filePath, fileName, onClose }: FileViewerModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const text = await OPFS.readFile(filePath);
        setContent(text);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    load();
  }, [filePath]);

  const handleCopy = async () => {
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isMarkdown = fileName.endsWith('.md');
  const isImage = fileName.match(/\.(png|jpg|jpeg|svg|gif)$/i);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="p-4 border-b border-border flex flex-row items-center justify-between">
          <DialogTitle className="text-sm font-mono truncate mr-4">{fileName}</DialogTitle>
          <button
            onClick={handleCopy}
            disabled={!content}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </DialogHeader>
        
        <div className="flex-1 overflow-auto p-4 bg-background">
          {error ? (
            <div className="text-destructive text-sm">Failed to load file: {error}</div>
          ) : content === null && !isImage ? (
            <div className="text-muted-foreground text-sm">Loading...</div>
          ) : isImage ? (
            <div className="flex items-center justify-center p-4">
              <span className="text-sm text-muted-foreground">Image preview not supported yet</span>
            </div>
          ) : isMarkdown ? (
            <div className="max-w-none">
              <Markdown source={content!} />
            </div>
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted p-4 rounded-md overflow-auto">
              {content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
