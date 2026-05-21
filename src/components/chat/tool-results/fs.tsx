import { FileText, FileCode, FileImage, File, Folder, Search, FolderOpen } from "lucide-react";

function fileIcon(filename: string) {
  const className = "size-3.5 shrink-0";
  if (/\.(md|txt)$/i.test(filename)) return <FileText className={className} />;
  if (/\.(ts|tsx|js|jsx|json|html|css|py|rs|go|java|c|cpp|sh)$/i.test(filename))
    return <FileCode className={className} />;
  if (/\.(png|jpe?g|svg|gif|webp|avif)$/i.test(filename))
    return <FileImage className={className} />;
  return <File className={className} />;
}

function CardShell({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        {header}
      </div>
      <div className="bg-background/50 max-h-64 overflow-y-auto styled-scrollbar">
        {children}
      </div>
    </div>
  );
}

// ─── Read File ──────────────────────────────────────────────────────────

export function ReadFileResult({ args, result }: { args: Record<string, unknown>; result: unknown }) {
  const filePath = (args.file_path as string | undefined) ?? "(unknown)";
  const name = filePath.split("/").pop() ?? filePath;
  const content = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const lineCount = content.split("\n").length;

  return (
    <CardShell
      header={
        <>
          <div className="flex items-center gap-1.5">
            {fileIcon(name)}
            <span className="font-mono truncate max-w-[220px]">{filePath}</span>
          </div>
          <span className="text-[10px] opacity-70">{lineCount} lines</span>
        </>
      }
    >
      <pre className="whitespace-pre px-3 py-2 font-mono text-foreground/80 overflow-x-auto">{content}</pre>
    </CardShell>
  );
}

// ─── Find Files (Glob) ──────────────────────────────────────────────────

export function GlobResult({ args, result }: { args: Record<string, unknown>; result: unknown }) {
  const pattern = (args.pattern as string | undefined) ?? "";
  const where = (args.path as string | undefined) ?? ".";
  const text = typeof result === "string" ? result : "";
  const paths = text.split("\n").map((p) => p.trim()).filter(Boolean);

  return (
    <CardShell
      header={
        <>
          <div className="flex items-center gap-1.5">
            <Search className="size-3" />
            <span>
              Pattern <span className="font-mono text-foreground/80">{pattern}</span>
              {where && where !== "." && (
                <> in <span className="font-mono text-foreground/80">{where}</span></>
              )}
            </span>
          </div>
          <span className="text-[10px] opacity-70">{paths.length} found</span>
        </>
      }
    >
      {paths.length === 0 ? (
        <div className="px-3 py-3 text-muted-foreground italic">No files matched.</div>
      ) : (
        <ul className="py-1">
          {paths.map((p) => (
            <li
              key={p}
              className="flex items-center gap-2 px-3 py-1 font-mono text-foreground/80"
            >
              {fileIcon(p)}
              <span className="truncate">{p}</span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

// ─── Search Content (Grep) ──────────────────────────────────────────────

export function GrepResult({ args, result }: { args: Record<string, unknown>; result: unknown }) {
  const pattern = (args.pattern as string | undefined) ?? "";
  const include = args.include as string | undefined;
  const text = typeof result === "string" ? result : "";
  const lines = text.split("\n").filter(Boolean);

  // Group "path:line:content" entries by path
  const groups = new Map<string, { line: string; content: string }[]>();
  for (const ln of lines) {
    const m = ln.match(/^(.+?):(\d+):(.*)$/);
    if (m) {
      const [, path, lineNo, content] = m;
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path)!.push({ line: lineNo, content });
    }
  }

  return (
    <CardShell
      header={
        <>
          <div className="flex items-center gap-1.5">
            <Search className="size-3" />
            <span>
              Searching for <span className="font-mono text-foreground/80">{pattern}</span>
              {include && (
                <> in <span className="font-mono text-foreground/80">{include}</span></>
              )}
            </span>
          </div>
          <span className="text-[10px] opacity-70">{lines.length} matches</span>
        </>
      }
    >
      {groups.size === 0 ? (
        <div className="px-3 py-3 text-muted-foreground italic">No matches.</div>
      ) : (
        <div className="py-1">
          {Array.from(groups.entries()).map(([path, hits]) => (
            <div key={path} className="px-3 py-1.5">
              <div className="flex items-center gap-1.5 font-mono text-foreground/90 mb-1">
                {fileIcon(path)}
                <span className="truncate">{path}</span>
                <span className="text-[10px] text-muted-foreground/70">
                  ({hits.length})
                </span>
              </div>
              <ul className="space-y-0.5 ml-5">
                {hits.slice(0, 8).map((hit, i) => (
                  <li key={i} className="font-mono text-foreground/70 text-[11px]">
                    <span className="text-muted-foreground/60 mr-2">{hit.line}</span>
                    <span className="whitespace-pre">{hit.content.trim()}</span>
                  </li>
                ))}
                {hits.length > 8 && (
                  <li className="text-[11px] text-muted-foreground/60">
                    + {hits.length - 8} more
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

// ─── List Folder (LS) ───────────────────────────────────────────────────

export function LSResult({ args, result }: { args: Record<string, unknown>; result: unknown }) {
  const path = (args.path as string | undefined) ?? ".";
  const text = typeof result === "string" ? result : "";
  const entries = text.split("\n").map((p) => p.trim()).filter(Boolean);

  const folders = entries.filter((e) => e.endsWith("/"));
  const files = entries.filter((e) => !e.endsWith("/"));

  return (
    <CardShell
      header={
        <>
          <div className="flex items-center gap-1.5">
            <FolderOpen className="size-3" />
            <span className="font-mono">{path || "(root)"}</span>
          </div>
          <span className="text-[10px] opacity-70">
            {folders.length} folders · {files.length} files
          </span>
        </>
      }
    >
      {entries.length === 0 ? (
        <div className="px-3 py-3 text-muted-foreground italic">Empty folder.</div>
      ) : (
        <ul className="py-1">
          {folders.map((f) => (
            <li
              key={f}
              className="flex items-center gap-2 px-3 py-1 font-mono text-foreground/80"
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">{f}</span>
            </li>
          ))}
          {files.map((f) => (
            <li
              key={f}
              className="flex items-center gap-2 px-3 py-1 font-mono text-foreground/80"
            >
              {fileIcon(f)}
              <span className="truncate">{f}</span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}
