import { Globe } from "lucide-react";
import { toolTabInfoStore } from "@/lib/agent/agent-transport";

interface Props {
  result: unknown;
  toolCallId: string;
}

/**
 * Render the `selectTab` result as a compact, clickable tab card (favicon +
 * title) instead of the raw `{ selected: true, tab: "t5" }` JSON. Tab metadata
 * comes from `toolTabInfoStore`, populated by the transport when the tool ran.
 * Clicking focuses the bound tab.
 */
export function SelectTabResult({ result, toolCallId }: Props) {
  const info = toolTabInfoStore.get(toolCallId);
  const r = result as { selected?: boolean; tab?: string } | undefined;
  const handle = typeof r?.tab === "string" ? r.tab : undefined;

  // No captured tab info (e.g. after a reload — the store is in-memory only).
  // Fall back to a minimal line referencing the handle.
  if (!info) {
    return (
      <div className="ml-3 mt-1 mb-1 px-3 py-2 rounded-md border border-border bg-background/50 text-xs text-muted-foreground">
        Bound tab{handle ? ` ${handle}` : ""} to this conversation.
      </div>
    );
  }

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          chrome.tabs.update(info.tabId, { active: true });
        }}
        title={info.title}
        className="flex w-full items-center gap-2 px-3 py-2 bg-background/50 text-left hover:bg-muted/60 transition-colors min-w-0"
      >
        {info.favIconUrl ? (
          <img src={info.favIconUrl} alt="" className="size-4 shrink-0 rounded-sm" />
        ) : (
          <Globe className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-foreground/90">{info.title || "Untitled tab"}</span>
        {handle && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {handle}
          </span>
        )}
      </button>
    </div>
  );
}
