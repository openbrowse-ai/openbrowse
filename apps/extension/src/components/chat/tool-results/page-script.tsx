import { Repeat } from "lucide-react";
import { ExpandableText } from "./expandable-text";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Result card for an `executeOnPage` run that executed a SAVED script by
 * reference (`scriptRef`). Distinct from {@link CodeResult}: there is no
 * inline `code` to show (the body is loaded from storage and never enters
 * context), so we render the reference + its `@desc` summary instead of an
 * empty code block, then the run's result/error/logs.
 */
export function PageScriptResult({ args, result }: Props) {
  const ref = args.scriptRef as
    | { skill?: string; script?: string }
    | undefined;
  const resultObj = result as
    | {
        result?: unknown;
        logs?: string[];
        error?: string;
        ranScript?: { skill: string; script: string; desc: string | null };
      }
    | undefined;

  // Prefer the descriptor the tool echoed back (carries the parsed @desc);
  // fall back to the call args before the result resolves.
  const skill = resultObj?.ranScript?.skill ?? ref?.skill ?? "";
  const script = resultObj?.ranScript?.script ?? ref?.script ?? "";
  const desc = resultObj?.ranScript?.desc ?? null;

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Repeat className="size-3 shrink-0" />
        <span className="truncate">
          Saved script
          {skill && script ? ` · ${skill} / ${script}` : ""}
        </span>
      </div>
      {desc && (
        <div className="px-3 pt-2 pb-1 bg-background/50 text-muted-foreground italic">
          {desc}
        </div>
      )}
      {resultObj &&
        (resultObj.error ||
          (resultObj.result !== undefined && resultObj.result !== null) ||
          (resultObj.logs && resultObj.logs.length > 0)) && (
          <div className="px-3 py-2 bg-muted/30 border-t border-border">
            {resultObj.error ? (
              <ExpandableText text={resultObj.error} className="text-red-400" />
            ) : resultObj.result !== undefined && resultObj.result !== null ? (
              <ExpandableText
                text={
                  typeof resultObj.result === "string"
                    ? resultObj.result
                    : JSON.stringify(resultObj.result, null, 2)
                }
                className="text-emerald-400"
              />
            ) : null}
            {resultObj.logs && resultObj.logs.length > 0 && (
              <div className="mt-1 pt-1 border-t border-border/50">
                <ExpandableText
                  text={resultObj.logs.join("\n")}
                  className="text-muted-foreground"
                />
              </div>
            )}
          </div>
        )}
    </div>
  );
}
