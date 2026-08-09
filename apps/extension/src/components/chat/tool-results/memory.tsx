import { Search } from "lucide-react";

interface SearchProps {
  args: Record<string, unknown>;
  result: unknown;
}

interface SearchHit {
  slug: string;
  title: string;
  description?: string;
  scope?: "user" | "space";
  snippet?: string;
  path?: string;
}

interface SearchRelated {
  slug: string;
  title: string;
  scope?: "user" | "space";
}

/** Renders the ranked results of a `searchMemory` call. */
export function SearchMemoryResult({ args, result }: SearchProps) {
  const query = typeof args.query === "string" ? args.query : "";
  const r = result as
    | { found?: boolean; results?: SearchHit[]; related?: SearchRelated[] }
    | undefined;

  const results = Array.isArray(r?.results) ? r.results : [];
  const related = Array.isArray(r?.related) ? r.related : [];
  const nothing = r != null && (r.found === false || results.length === 0);

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground font-mono">
        <Search className="size-3 shrink-0" />
        <span className="truncate">
          Memory search{query ? `: ${query}` : ""}
        </span>
      </div>
      {nothing ? (
        <div className="px-3 py-2 bg-background/50 text-muted-foreground">
          No matching memories.
        </div>
      ) : (
        <div className="px-3 py-2 bg-background/50 flex flex-col gap-2">
          {results.map((hit) => (
            // A global and a space note can share a slug, so key on the path.
            <div key={hit.path ?? hit.slug} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{hit.title}</span>
                {hit.scope ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {hit.scope}
                  </span>
                ) : null}
              </div>
              {hit.snippet ? (
                <span className="text-muted-foreground line-clamp-2">
                  {hit.snippet}
                </span>
              ) : hit.description ? (
                <span className="text-muted-foreground line-clamp-2">
                  {hit.description}
                </span>
              ) : null}
            </div>
          ))}
          {related.length > 0 ? (
            <div className="pt-1 border-t border-border text-muted-foreground">
              Related: {related.map((rel) => rel.title).join(", ")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
