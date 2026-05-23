import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { CodeViewer } from "@/components/chat/CodeViewer";

export type JsonViewerMode = "tree" | "raw";

interface JsonViewerProps {
  text: string;
  fileName: string;
  /** Controlled mode — toolbar lives in the parent panel. */
  mode: JsonViewerMode;
  /**
   * Reports parse-derived metadata back to the parent so the panel header
   * can show record counts / error banners alongside the mode toggle.
   * Optional; safe to omit.
   */
  onParseMeta?: (meta: ParseMeta) => void;
  className?: string;
}

export interface ParseMeta {
  /** Number of JSONL records, or null for non-JSONL files. */
  lineCount: number | null;
  /** True if the document failed to parse at all (single JSON only). */
  hasError: boolean;
  /** Human-readable banner text — error message or per-line count. */
  errorBanner: string | null;
}

interface ParsedSingle {
  kind: "single";
  data: unknown;
}

interface ParsedLines {
  kind: "lines";
  /** Parsed entries; entries that failed to parse are kept as raw text. */
  entries: Array<
    | { ok: true; data: unknown; raw: string }
    | { ok: false; raw: string; error: string }
  >;
  errorCount: number;
}

interface ParsedError {
  kind: "error";
  error: string;
}

type ParsedJson = ParsedSingle | ParsedLines | ParsedError;

function isJsonl(fileName: string): boolean {
  return /\.(jsonl|ndjson)$/i.test(fileName);
}

function parseJsonText(text: string, fileName: string): ParsedJson {
  if (isJsonl(fileName)) {
    const lines = text.split(/\r?\n/);
    const entries: ParsedLines["entries"] = [];
    let errorCount = 0;
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        entries.push({ ok: true, data: JSON.parse(trimmed), raw });
      } catch (e) {
        errorCount++;
        entries.push({ ok: false, raw, error: (e as Error).message });
      }
    }
    return { kind: "lines", entries, errorCount };
  }
  try {
    return { kind: "single", data: JSON.parse(text) };
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

/** Pretty-print JSON for the Raw mode. JSONL is preserved line-by-line. */
function prettify(text: string, fileName: string): string {
  if (isJsonl(fileName)) {
    return text
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        try {
          return JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch {
          return line;
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Theme-aware style overrides for `react-json-view-lite`. We deliberately do
 * NOT import the bundled `react-json-view-lite/dist/index.css` — its dark
 * theme bakes in a navy background and Solarized palette that clash with the
 * app's light/dark tokens. Instead we hand each style slot a Tailwind class
 * string driven by the project's CSS variables (`text-foreground`, etc.) so
 * the tree reads correctly in both modes.
 *
 * The expand/collapse arrows are drawn via `after:content-['…']` because
 * those glyphs live on `::after` pseudo-elements in the library's default
 * styles; replacing the class strings strips the original `::after` rules,
 * so we re-add equivalents here.
 */
const customJsonStyles = {
  container: "font-mono text-xs leading-relaxed",
  basicChildStyle: "ml-4",
  label: "text-sky-700 dark:text-sky-300 mr-1.5",
  clickableLabel:
    "text-sky-700 dark:text-sky-300 mr-1.5 cursor-pointer hover:underline",
  nullValue: "text-muted-foreground italic",
  undefinedValue: "text-muted-foreground italic",
  numberValue: "text-violet-600 dark:text-violet-400",
  stringValue: "text-emerald-700 dark:text-emerald-300",
  booleanValue: "text-amber-600 dark:text-amber-400",
  otherValue: "text-foreground",
  punctuation: "text-muted-foreground/70 mr-1",
  expandIcon:
    "select-none mr-1 text-muted-foreground after:content-['▸'] cursor-pointer",
  collapseIcon:
    "select-none mr-1 text-muted-foreground after:content-['▾'] cursor-pointer",
  collapsedContent:
    "after:content-['…'] after:text-muted-foreground/70 mr-1 cursor-pointer",
  childFieldsContainer: "",
  ariaLables: {
    collapseJson: "Collapse",
    expandJson: "Expand",
  },
  stringifyStringValues: true,
} as const;

/**
 * Initial expansion strategy: top two levels open. MUST be a stable
 * (module-scoped) reference — react-json-view-lite re-runs this and resets
 * every node's expanded state whenever the function reference changes
 * (see ExpandableObject's `useEffect([shouldExpandNode])` in the lib).
 * Defining it inline in the component would collapse every expanded node on
 * the next parent re-render.
 */
const shouldExpandNode = (level: number) => level < 2;

/**
 * Lazy-loaded JsonView from `react-json-view-lite`. The component is only
 * mounted when Tree mode is active.
 */
function LazyJsonTree({ data }: { data: unknown }) {
  const [Mod, setMod] = useState<typeof import("react-json-view-lite") | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import("react-json-view-lite");
      if (!cancelled) setMod(mod);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!Mod) {
    return (
      <div className="text-sm text-muted-foreground">Loading tree…</div>
    );
  }
  const { JsonView } = Mod;
  return (
    <JsonView
      data={data as object}
      shouldExpandNode={shouldExpandNode}
      style={customJsonStyles}
      clickToExpandNode
    />
  );
}

export function JsonViewer({
  text,
  fileName,
  mode,
  onParseMeta,
  className,
}: JsonViewerProps) {
  const parsed = useMemo(() => parseJsonText(text, fileName), [text, fileName]);
  const pretty = useMemo(
    () => (mode === "raw" ? prettify(text, fileName) : ""),
    [text, fileName, mode],
  );

  // Surface parse meta to the parent toolbar (record count / error banner).
  useEffect(() => {
    if (!onParseMeta) return;
    const errorBanner =
      parsed.kind === "error"
        ? `Invalid JSON: ${parsed.error}`
        : parsed.kind === "lines" && parsed.errorCount > 0
          ? `${parsed.errorCount} line${parsed.errorCount === 1 ? "" : "s"} failed to parse.`
          : null;
    const lineCount = parsed.kind === "lines" ? parsed.entries.length : null;
    onParseMeta({
      lineCount,
      hasError: parsed.kind === "error",
      errorBanner,
    });
  }, [parsed, onParseMeta]);

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="flex-1 overflow-auto">
        {mode === "raw" ? (
          <CodeViewer
            code={pretty}
            language="json"
            className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
          />
        ) : parsed.kind === "single" ? (
          <div className="p-4 text-sm font-mono">
            <LazyJsonTree data={parsed.data} />
          </div>
        ) : parsed.kind === "lines" ? (
          <div className="p-4 text-sm font-mono space-y-3">
            {parsed.entries.map((entry, i) =>
              entry.ok ? (
                <div key={i} className="border-l-2 border-border pl-3 py-1">
                  <div className="text-[10px] text-muted-foreground/70 mb-1">
                    #{i + 1}
                  </div>
                  <LazyJsonTree data={entry.data} />
                </div>
              ) : (
                <div
                  key={i}
                  className="border-l-2 border-destructive/60 pl-3 py-1"
                >
                  <div className="text-[10px] text-destructive mb-1">
                    #{i + 1} — {entry.error}
                  </div>
                  <pre className="text-xs whitespace-pre-wrap text-muted-foreground">
                    {entry.raw}
                  </pre>
                </div>
              ),
            )}
          </div>
        ) : parsed.kind === "error" ? (
          <div className="p-6 text-destructive text-sm">
            Invalid JSON: {parsed.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
