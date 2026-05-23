import { ExternalLink, Globe } from "lucide-react";
import Markdown from "react-markdown";

interface WebFetchOutput {
  url?: string;
  status?: number;
  contentType?: string;
  format?: "markdown" | "text" | "html";
  content?: string;
  summarized?: boolean;
  originalLength?: number;
  redirected?: boolean;
  redirectedFrom?: string;
}

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}

function statusTone(status?: number): string {
  if (status == null) return "text-muted-foreground bg-muted/60";
  if (status >= 200 && status < 300)
    return "text-green-600 bg-green-500/10 dark:text-green-400";
  if (status >= 300 && status < 400)
    return "text-blue-600 bg-blue-500/10 dark:text-blue-400";
  if (status >= 400) return "text-red-600 bg-red-500/10 dark:text-red-400";
  return "text-muted-foreground bg-muted/60";
}

function shortContentType(ct?: string): string | null {
  if (!ct) return null;
  // e.g. "text/html; charset=utf-8" → "text/html"
  const semi = ct.indexOf(";");
  return (semi === -1 ? ct : ct.slice(0, semi)).trim() || null;
}

export function WebFetchResult({ args, result }: Props) {
  const out = (result ?? {}) as WebFetchOutput;
  const requestedUrl =
    typeof args.url === "string" ? (args.url as string) : "";
  const finalUrl = out.url ?? requestedUrl;
  const ct = shortContentType(out.contentType);
  const charCount = typeof out.content === "string" ? out.content.length : 0;
  const isMarkdown = out.format === "markdown";

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Globe className="size-3 shrink-0" />
        {finalUrl ? (
          <a
            href={finalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono truncate hover:text-foreground hover:underline underline-offset-2 inline-flex items-center gap-1 min-w-0"
            title={finalUrl}
          >
            <span className="truncate">{truncateMiddle(finalUrl, 80)}</span>
            <ExternalLink className="size-3 shrink-0 opacity-60" />
          </a>
        ) : (
          <span className="font-mono truncate">webFetch</span>
        )}
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 border-b border-border bg-background/50">
        {out.status != null && (
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${statusTone(
              out.status,
            )}`}
          >
            {out.status}
          </span>
        )}
        {ct && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
            {ct}
          </span>
        )}
        {out.format && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
            {out.format}
          </span>
        )}
        {charCount > 0 && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
            {formatChars(charCount)}
          </span>
        )}
        {out.summarized && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400"
            title={
              out.originalLength != null
                ? `Summarized from ${out.originalLength.toLocaleString()} chars`
                : "Summarized"
            }
          >
            summarized
          </span>
        )}
        {out.redirected && out.redirectedFrom && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-blue-500/15 text-blue-700 dark:text-blue-400"
            title={`Redirected from ${out.redirectedFrom}`}
          >
            redirected
          </span>
        )}
      </div>

      {/* Body */}
      {out.content != null && (
        <div className="bg-background/50 max-h-72 overflow-y-auto styled-scrollbar">
          {isMarkdown ? (
            <div className="px-3 py-2 prose prose-sm dark:prose-invert max-w-none text-foreground/80 prose-p:leading-snug prose-pre:bg-muted/50 prose-pre:text-[11px] prose-headings:text-foreground/90 prose-a:text-blue-600 dark:prose-a:text-blue-400">
              <Markdown>{out.content}</Markdown>
            </div>
          ) : (
            <pre className="px-3 py-2 whitespace-pre-wrap font-mono text-[11px] text-foreground/80">
              {out.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
