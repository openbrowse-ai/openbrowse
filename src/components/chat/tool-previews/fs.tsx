import { FileText, FileCode, FileImage, File } from "lucide-react";
import { registerToolPreview } from "./registry";

function fileIcon(filename: string) {
  const className = "size-3.5 shrink-0";
  if (/\.(md|txt)$/i.test(filename)) return <FileText className={className} />;
  if (/\.(ts|tsx|js|jsx|json|html|css|py|rs|go|java|c|cpp|sh)$/i.test(filename))
    return <FileCode className={className} />;
  if (/\.(png|jpe?g|svg|gif|webp|avif)$/i.test(filename))
    return <FileImage className={className} />;
  return <File className={className} />;
}

// ─── Write ──────────────────────────────────────────────────────────────

registerToolPreview("Write", (args) => {
  const filePath = (args.file_path as string | undefined) ?? "(unknown)";
  const content = (args.content as string | undefined) ?? "";
  const lineCount = content ? content.split("\n").length : 0;

  return (
    <div className="rounded-md border border-border overflow-hidden text-xs">
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <div className="flex items-center gap-1.5">
          {fileIcon(filePath)}
          <span className="font-mono truncate max-w-[220px]">{filePath}</span>
        </div>
        <span className="text-[10px] opacity-70">{lineCount} lines</span>
      </div>
      <pre className="whitespace-pre px-3 py-2 bg-background/50 max-h-64 overflow-y-auto styled-scrollbar font-mono text-foreground/80 overflow-x-auto">
        {content}
      </pre>
    </div>
  );
});

// ─── Edit ───────────────────────────────────────────────────────────────

registerToolPreview("Edit", (args) => {
  const filePath = (args.file_path as string | undefined) ?? "(unknown)";
  const oldString = (args.oldString as string | undefined) ?? "";
  const newString = (args.newString as string | undefined) ?? "";
  const replaceAll = !!args.replaceAll;

  return (
    <div className="rounded-md border border-border overflow-hidden text-xs">
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <div className="flex items-center gap-1.5">
          {fileIcon(filePath)}
          <span className="font-mono truncate max-w-[220px]">{filePath}</span>
        </div>
        {replaceAll && (
          <span className="text-[10px] opacity-70">replace all</span>
        )}
      </div>
      <div className="bg-background/50 max-h-64 overflow-y-auto styled-scrollbar">
        <pre className="whitespace-pre px-3 py-1.5 font-mono text-red-600/90 dark:text-red-400/90 bg-red-500/5 border-l-2 border-red-500/40 overflow-x-auto">
          {oldString.split("\n").map((line) => `- ${line}`).join("\n")}
        </pre>
        <pre className="whitespace-pre px-3 py-1.5 font-mono text-green-700/90 dark:text-green-400/90 bg-green-500/5 border-l-2 border-green-500/40 overflow-x-auto">
          {newString.split("\n").map((line) => `+ ${line}`).join("\n")}
        </pre>
      </div>
    </div>
  );
});
