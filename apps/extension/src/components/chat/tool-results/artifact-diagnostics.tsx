import { AlertCircle, CheckCircle2, Clock, Terminal } from "lucide-react";

interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  text: string;
  ts: number;
}

interface ErrorEntry {
  message: string;
  stack?: string;
  sourceFile?: string;
  recentConsole?: string[];
  ts: number;
}

interface DiagnosticsOutput {
  artifactId?: string;
  rendered?: { childCount: number; bodyTextSample: string } | null;
  console?: ConsoleEntry[];
  errors?: ErrorEntry[];
  startedAt?: number | null;
  waitedMs?: number;
  note?: string;
}

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

function levelTone(level: ConsoleEntry["level"]): string {
  switch (level) {
    case "error":
      return "text-destructive";
    case "warn":
      return "text-yellow-600 dark:text-yellow-500";
    case "info":
      return "text-blue-600 dark:text-blue-400";
    default:
      return "text-foreground/80";
  }
}

/**
 * Renders the `read_artifact_diagnostics` result as a verification card
 * (status + errors + forwarded console) instead of a raw JSON blob. Three
 * outcomes drive the header tone:
 *   - errored   → red "Errored" with the uncaught error(s) surfaced first.
 *   - rendered  → green "Rendered" with childCount / body sample.
 *   - neither   → muted "No render yet" (still loading / didn't mount).
 */
export function ArtifactDiagnosticsResult({ args, result }: Props) {
  const out = (result ?? {}) as DiagnosticsOutput;
  const artifactId =
    typeof args?.artifactId === "string" ? args.artifactId : out.artifactId;
  const errors = out.errors ?? [];
  const consoleEntries = out.console ?? [];
  const rendered = out.rendered ?? null;

  const status: "errored" | "rendered" | "pending" =
    errors.length > 0 ? "errored" : rendered ? "rendered" : "pending";

  const header =
    status === "errored"
      ? {
          icon: <AlertCircle className="size-3.5 shrink-0 text-destructive" />,
          label: errors.length === 1 ? "1 error" : `${errors.length} errors`,
          tone: "text-destructive",
          bg: "bg-destructive/10",
        }
      : status === "rendered"
        ? {
            icon: (
              <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />
            ),
            label: "Rendered",
            tone: "text-green-700 dark:text-green-400",
            bg: "bg-green-500/10",
          }
        : {
            icon: <Clock className="size-3.5 shrink-0 text-muted-foreground" />,
            label: "No render reported",
            tone: "text-muted-foreground",
            bg: "bg-muted/60",
          };

  return (
    <div className="ml-3 mt-1 mb-1 overflow-hidden rounded-md border border-border text-xs">
      {/* Status header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-2.5 py-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${header.bg} ${header.tone}`}
        >
          {header.icon}
          {header.label}
        </span>
        {rendered && (
          <span className="text-[11px] text-muted-foreground">
            {rendered.childCount}{" "}
            {rendered.childCount === 1 ? "element" : "elements"}
          </span>
        )}
        {typeof out.waitedMs === "number" && (
          <span className="ml-auto text-[10px] text-muted-foreground/70">
            waited {out.waitedMs}ms
          </span>
        )}
      </div>

      {/* Errors first — that's what the agent needs to act on. */}
      {errors.length > 0 && (
        <div className="border-b border-border bg-background/50">
          {errors.map((e, i) => (
            <div key={i} className="px-2.5 py-1.5">
              <div className="font-mono text-[11px] font-medium text-destructive">
                {e.message}
              </div>
              {e.sourceFile && (
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {e.sourceFile}
                </div>
              )}
              {e.stack && (
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground styled-scrollbar">
                  {e.stack}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Forwarded console. */}
      {consoleEntries.length > 0 && (
        <div className="bg-background/50">
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            <Terminal className="size-3 shrink-0" />
            Console ({consoleEntries.length})
          </div>
          <div className="max-h-48 overflow-y-auto px-2.5 py-1.5 font-mono text-[11px] leading-relaxed styled-scrollbar">
            {consoleEntries.map((c, i) => (
              <div key={i} className={levelTone(c.level)}>
                <span className="select-none text-muted-foreground/60">
                  {c.level}{" "}
                </span>
                <span className="whitespace-pre-wrap break-words">{c.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Body sample on a clean render (no console / no errors to show). */}
      {status === "rendered" &&
        consoleEntries.length === 0 &&
        rendered?.bodyTextSample && (
          <div className="bg-background/50 px-2.5 py-1.5">
            <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Body sample
            </div>
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/70 styled-scrollbar">
              {rendered.bodyTextSample}
            </pre>
          </div>
        )}

      {/* Agent-facing note (e.g. "didn't mount, retry"). */}
      {out.note && (
        <div className="border-t border-border bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {out.note}
        </div>
      )}

      {artifactId && (
        <div className="border-t border-border bg-background/50 px-2.5 py-1 font-mono text-[10px] text-muted-foreground/60">
          {artifactId}
        </div>
      )}
    </div>
  );
}
