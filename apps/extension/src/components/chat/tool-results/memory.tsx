import { Database } from "lucide-react";
import { HighlightedCode } from "./highlighted-code";
import { buildAdditionDiff } from "@/lib/agent/tools/memory-diff";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
  action: "save" | "update";
}

export function MemoryResult({ args, result, action }: Props) {
  const content = typeof args.content === "string" ? args.content : "";

  // Handle the "didn't happen" outcomes (e.g. update failed, save collided).
  const r = result as
    | {
        saved?: boolean;
        updated?: boolean;
        reason?: string;
        diffPreview?: string;
        scope?: "user" | "space";
      }
    | undefined;
  const failed =
    r != null &&
    ((action === "save" && r.saved === false) ||
      (action === "update" && r.updated === false));

  let diffText: string;
  if (action === "update" && typeof r?.diffPreview === "string") {
    // The updateMemory tool computes the diff at execute time (keeps the
    // result lightweight — no full memory bodies in the transcript).
    diffText = r.diffPreview;
  } else {
    // Save (or update before result resolves): show the content as additions.
    diffText = buildAdditionDiff(content);
  }

  const title = typeof args.title === "string" ? args.title : undefined;
  // Scope badge surfaces where the memory landed so a misfile is easy to
  // spot. Falls back to nothing when the tool result hasn't resolved yet
  // or when the action failed (no scope to report).
  const scopeBadge =
    !failed && r?.scope === "space"
      ? "in this space"
      : !failed && r?.scope === "user"
        ? "globally"
        : null;
  const headerLabel = action === "save" ? "Memory saved" : "Memory updated";

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Database className="size-3 shrink-0" />
        <span className="truncate">
          {headerLabel}
          {scopeBadge ? ` ${scopeBadge}` : ""}
          {title ? `: ${title}` : ""}
        </span>
      </div>
      {failed ? (
        <div className="px-3 py-2 bg-background/50 text-muted-foreground">
          {r?.reason ?? "No change made."}
        </div>
      ) : (
        <div className="px-3 py-2 bg-background/50 overflow-x-auto">
          <HighlightedCode code={diffText} lang="diff" maxLines={15} />
        </div>
      )}
    </div>
  );
}
