import { ExternalLink, Search } from "lucide-react";

interface WebSearchResultItem {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  highlights?: string[];
}

interface WebSearchOutput {
  results?: WebSearchResultItem[];
  error?: string;
}

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconFor(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${h}&sz=32`;
  } catch {
    return null;
  }
}

export function WebSearchResult({ args, result }: Props) {
  const out = (result ?? {}) as WebSearchOutput;
  const query = typeof args.query === "string" ? (args.query as string) : "";
  const results = Array.isArray(out.results) ? out.results : [];

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      {/* Header: the query + result count */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Search className="size-3 shrink-0" />
        <span className="truncate min-w-0" title={query}>
          {query || "Web search"}
        </span>
        {!out.error && (
          <span className="ml-auto shrink-0 text-[10px] tabular-nums">
            {results.length} {results.length === 1 ? "result" : "results"}
          </span>
        )}
      </div>

      {out.error ? (
        <div className="px-2.5 py-2 text-red-600 dark:text-red-400">
          {out.error}
        </div>
      ) : results.length === 0 ? (
        <div className="px-2.5 py-2 text-muted-foreground">No results.</div>
      ) : (
        <ul className="divide-y divide-border max-h-80 overflow-y-auto styled-scrollbar bg-background/50">
          {results.map((r, i) => {
            const url = r.url ?? "";
            const host = url ? hostOf(url) : "";
            const favicon = url ? faviconFor(url) : null;
            const snippet =
              r.highlights && r.highlights.length
                ? r.highlights.join(" … ")
                : (r.text ?? "");
            return (
              <li key={`${url}-${i}`} className="px-2.5 py-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 min-w-0 max-w-full"
                  title={r.title || url}
                >
                  <span className="truncate">{r.title || host || url}</span>
                  <ExternalLink className="size-3 shrink-0 opacity-60" />
                </a>
                {host && (
                  <div className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground">
                    {favicon && (
                      <img
                        src={favicon}
                        alt=""
                        className="size-3 rounded-sm shrink-0"
                      />
                    )}
                    <span className="truncate">{host}</span>
                    {r.publishedDate && (
                      <span className="opacity-70 shrink-0">
                        · {r.publishedDate.slice(0, 10)}
                      </span>
                    )}
                  </div>
                )}
                {snippet && (
                  <p className="mt-1 text-foreground/70 line-clamp-2 leading-snug">
                    {snippet}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
