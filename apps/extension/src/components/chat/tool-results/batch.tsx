import {
    type BatchInvocationResult,
    normalizeInvocationArguments,
    readBatchInvocations,
    readBatchResults,
} from "@/lib/agent/tools/batch-args";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ExpandableText } from "./expandable-text";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
  /**
   * Renders one invocation's result using the SAME renderer the tool
   * would get as a direct call, so a batched `snapshot` looks like a
   * snapshot and a batched `Grep` looks like a grep.
   *
   * Injected by `ToolCallBlock` rather than imported here: the renderer
   * map lives in that module, and importing it would form a cycle.
   * Returns `undefined` when the child tool has no custom renderer, in
   * which case we fall back to a JSON dump.
   */
  renderChild: (
    name: string,
    childArgs: Record<string, unknown>,
    childResult: unknown,
  ) => ReactNode | undefined;
}

/**
 * Best-effort argument object for display. A malformed `arguments` value
 * (the invocation will have failed with a parse error) renders as no
 * arguments rather than blowing up the row.
 */
function argsOf(raw: unknown): Record<string, unknown> {
  const normalized = normalizeInvocationArguments(raw);
  return normalized.ok ? normalized.value : {};
}

/** Longest arg summary we render before eliding; rows must stay one line. */
const SUMMARY_MAX = 52;

/**
 * One-line argument summary for a collapsed invocation row.
 *
 * Prefers string arguments and shows at most two of them, because those
 * are the ones that identify the call — a `webSearch` row wants its
 * `query`, not `numResults: 8` crowding the query out. Numeric and
 * boolean arguments are tuning knobs; they only appear when a call has
 * nothing else to show for itself.
 */
export function summarizeArgs(childArgs: Record<string, unknown>): string {
  const entries = Object.entries(childArgs).filter(
    ([, value]) => value != null && value !== "",
  );
  const strings = entries.filter(([, value]) => typeof value === "string");
  const chosen = (strings.length > 0 ? strings : entries).slice(0, 2);

  const parts = chosen.map(([key, value]) => {
    if (typeof value === "string") return `${key}: ${value}`;
    if (typeof value === "number" || typeof value === "boolean") {
      return `${key}: ${value}`;
    }
    return `${key}: ${Array.isArray(value) ? `[${value.length}]` : "{…}"}`;
  });

  const summary = parts.join(" · ");
  return summary.length > SUMMARY_MAX
    ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : summary;
}

function InvocationRow({
  invocationResult,
  childArgs,
  renderChild,
}: {
  invocationResult: BatchInvocationResult;
  childArgs: Record<string, unknown>;
  renderChild: Props["renderChild"];
}) {
  const [open, setOpen] = useState(false);
  const { name, ok, output, error } = invocationResult;
  const summary = summarizeArgs(childArgs);
  // A failed invocation may still carry output — tools that report
  // failure in-band (`{ results: [], error }`) hand back a payload their
  // own renderer already presents well. Prefer that over our error text.
  const child = output === undefined ? undefined : renderChild(name, childArgs, output);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-mx-1 flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left transition-colors hover:bg-accent/50"
      >
        {ok ? (
          <Check className="size-3 shrink-0 text-emerald-600/80 dark:text-emerald-500/80" />
        ) : (
          <X className="size-3 shrink-0 text-destructive/80" />
        )}
        <span className="shrink-0 font-mono text-foreground/80">{name}</span>
        {summary && (
          <span className="truncate text-muted-foreground/70">{summary}</span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 text-muted-foreground/50 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="pb-1">
          {child ??
            (ok ? (
              <div className="px-1 py-1">
                <ExpandableText
                  text={
                    typeof output === "string"
                      ? output
                      : JSON.stringify(output, null, 2)
                  }
                  className="font-mono text-foreground/80"
                />
              </div>
            ) : (
              <div className="px-1 py-1">
                <ExpandableText
                  text={error ?? "Failed with no error message."}
                  className="font-mono text-destructive"
                />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a `batch` tool call as a flat, indented list of invocations.
 *
 * Deliberately draws NO card of its own. Every child result renderer
 * already brings its own bordered card, and the collapsed row above
 * already reports the count — a wrapper here would put a box inside a box
 * inside a box. Instead this follows the same left-rule indent
 * `ToolCallBlock` uses for nested tool content, so the only border on
 * screen belongs to whichever child the user opened.
 *
 * Rows are driven by the RESULT array (the authoritative record of what
 * ran), with arguments joined in by index from the input. While the call
 * is still streaming there is no result yet, so the requested invocations
 * render as inert rows.
 */
export function BatchResult({ args, result, renderChild }: Props) {
  const invocations = readBatchInvocations(args);
  const results = readBatchResults(result);

  // `toSDKTool` replaces the whole output with `{ error }` if the batch
  // tool itself throws, as opposed to an individual invocation failing.
  const topLevelError = (result as { error?: unknown } | null | undefined)
    ?.error;
  if (typeof topLevelError === "string" && results.length === 0) {
    return (
      <div className="ml-3 mt-1 border-l border-muted pb-1 pl-3 text-xs">
        <ExpandableText
          text={topLevelError}
          className="font-mono text-destructive"
        />
      </div>
    );
  }

  if (results.length === 0) {
    if (invocations.length === 0) return null;
    return (
      <div className="ml-3 mt-1 flex flex-col border-l border-muted pb-1 pl-3 text-xs">
        {invocations.map((invocation, index) => (
          <div
            key={`${invocation.name}-${index}`}
            className="flex items-center gap-1.5 py-1"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            <span className="shrink-0 font-mono text-foreground/70">
              {invocation.name}
            </span>
            <span className="truncate text-muted-foreground/70">
              {summarizeArgs(argsOf(invocation.arguments))}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="ml-3 mt-1 flex flex-col border-l border-muted pb-1 pl-3 text-xs">
      {results.map((invocationResult, index) => (
        <InvocationRow
          key={`${invocationResult.name}-${index}`}
          invocationResult={invocationResult}
          childArgs={argsOf(invocations[index]?.arguments)}
          renderChild={renderChild}
        />
      ))}
    </div>
  );
}
