import { ChevronRight, Globe, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { toolResultStore, toolTabInfoStore } from "@/lib/agent/agent-transport";
import { getConnectorForMcpTool } from "@/registry/connectors";
import { getMcpRegistry } from "@/lib/mcp";
import { SnapshotResult } from "./tool-results/snapshot";
import { ScreenshotResult } from "./tool-results/screenshot";
import { CodeResult } from "./tool-results/execute-code";

import { getToolPreview } from "./tool-previews";

type ResultRenderer = (props: { args: Record<string, unknown>; result: unknown }) => ReactNode;

const BUILTIN_RESULT_RENDERERS: Record<string, ResultRenderer> = {
  snapshot: ({ result }) => <SnapshotResult result={result} />,
  screenshot: ({ result }) => <ScreenshotResult result={result} />,
  executeCode: ({ args, result }) => <CodeResult args={args} result={result} />,
  executeOnPage: ({ args, result }) => <CodeResult args={args} result={result} />,
};

interface ToolCallBlockProps {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  state: "call" | "result" | "denied";
}

const TOOL_LABELS: Record<string, { pending: string; done: string }> = {
  readPage: { pending: "Reading page...", done: "Read page" },
  screenshot: { pending: "Taking screenshot...", done: "Took screenshot" },
  listTabs: { pending: "Listing tabs...", done: "Listed tabs" },
  navigate: { pending: "Navigating...", done: "Navigated" },
  selectTab: { pending: "Switching tab...", done: "Switched tab" },
  clickElement: { pending: "Clicking...", done: "Clicked" },
  typeInElement: { pending: "Typing...", done: "Typed" },
  scrollPage: { pending: "Scrolling...", done: "Scrolled" },
  executeCode: { pending: "Running code...", done: "Ran code" },
  executeOnPage: { pending: "Running on page...", done: "Ran on page" },
  snapshot: { pending: "Taking snapshot...", done: "Snapshot" },
  saveMemory: { pending: "Saving memory...", done: "Saved memory" },
  updateMemory: { pending: "Updating memory...", done: "Updated memory" },
  deleteMemory: { pending: "Deleting memory...", done: "Deleted memory" },
  recallMemory: { pending: "Recalling memory...", done: "Recalled memory" },
  todoWrite: { pending: "Updating plan...", done: "Updated plan" },
  extract: { pending: "Extracting data...", done: "Extracted data" },
};

const TAB_TOOLS = new Set([
  "readPage", "screenshot", "navigate", "clickElement",
  "typeInElement", "scrollPage", "selectTab", "executeOnPage", "snapshot",
]);

export function TabBadge({ toolCallId }: { toolCallId: string }) {
  const info = toolTabInfoStore.get(toolCallId);
  if (!info) return null;

  const truncatedTitle = info.title.length > 24 ? info.title.slice(0, 22) + "…" : info.title;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        chrome.tabs.update(info.tabId, { active: true });
      }}
      title={info.title}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground bg-muted/50 hover:bg-muted hover:text-foreground transition-colors ml-1.5 max-w-[160px] shrink-0"
    >
      {info.favIconUrl ? (
        <img src={info.favIconUrl} alt="" className="size-3 shrink-0 rounded-sm" />
      ) : (
        <Globe className="size-3 shrink-0" />
      )}
      <span className="truncate">{truncatedTitle}</span>
    </button>
  );
}

function parseMcpToolName(toolKey: string): string | null {
  const match = toolKey.match(/^mcp_[^_]+_(.+)$/);
  if (!match) return null;
  return match[1].replace(/_/g, " ").replace(/-/g, " ");
}

export function ToolCallBlock({ toolName, toolCallId, args, result, state }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const pending = state === "call";
  const denied = state === "denied";
  const resolvedResult = result ?? toolResultStore.get(toolCallId);
  const serverIdMatch = toolName.match(/^mcp_([^_]+)_/);
  const serverUrl = serverIdMatch
    ? getMcpRegistry().getStates().find((s) => s.config.id === serverIdMatch[1])?.config.url
    : undefined;
  const mcpInfo = getConnectorForMcpTool(toolName, serverUrl);
  const mcpName = mcpInfo ? mcpInfo.toolName.replace(/_/g, " ").replace(/-/g, " ") : parseMcpToolName(toolName);
  const connectorLabels = mcpInfo?.connector.formatLabel?.(mcpInfo.toolName, resolvedResult) ?? null;
  const labels = TOOL_LABELS[toolName] ?? connectorLabels ?? {
    pending: mcpName ? `Running ${mcpName}...` : `${toolName}...`,
    done: mcpName ? mcpName : toolName,
  };

  const showTabBadge = TAB_TOOLS.has(toolName);

  // Denied: compact non-expandable row with a muted "Denied" suffix
  if (denied) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 px-1 -mx-1 text-sm">
        <X className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="text-muted-foreground/70 line-through">{labels.done}</span>
        {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        <span className="text-[11px] text-muted-foreground/60 ml-1">Denied</span>
      </div>
    );
  }

  // Resolve custom renderer: built-in map first, then connector's renderResult
  const builtinRenderer = BUILTIN_RESULT_RENDERERS[toolName];
  const mcpToolName = mcpInfo?.toolName;
  const connectorRenderer = mcpInfo?.connector.renderResult;
  const customRenderer: ResultRenderer | undefined = builtinRenderer
    ?? (connectorRenderer && mcpToolName
      ? ({ result }) => connectorRenderer(mcpToolName, result)
      : undefined);

  // Tools with custom renderers: always-expanded when done
  if (customRenderer && !pending && resolvedResult) {
    const rendered = customRenderer({ args, result: resolvedResult });
    if (rendered !== null) {
      return (
        <div className="flex flex-col w-full">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 py-0.5 cursor-pointer rounded-sm hover:bg-accent/50 transition-colors px-1 -mx-1 text-left"
          >
            {mcpInfo ? (
              <RegistryIcon id={mcpInfo.connector.id} className="size-3.5 shrink-0" />
            ) : (
              <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground/40" />
            )}
            <span className="text-sm text-muted-foreground">{labels.done}</span>
            {showTabBadge && <TabBadge toolCallId={toolCallId} />}
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground/60 transition-transform",
                expanded && "rotate-90"
              )}
            />
          </button>
          {expanded && rendered}
        </div>
      );
    }
  }

  // Default: collapsible with JSON fallback
  return (
    <div className="flex flex-col w-full">
      <button
        type="button"
        onClick={() => !pending && setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1.5 py-0.5 text-left",
          !pending && "cursor-pointer rounded-sm hover:bg-accent/50 transition-colors px-1 -mx-1"
        )}
        disabled={pending}
      >
        {mcpInfo ? (
          <RegistryIcon id={mcpInfo.connector.id} className="size-3.5 shrink-0" />
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full shrink-0",
              pending ? "bg-blue-500 animate-pulse" : "bg-muted-foreground/40"
            )}
          />
        )}
        {pending ? (
          <span className={cn("text-sm text-muted-foreground", !mcpInfo && "animate-pulse")}>{labels.pending}</span>
        ) : (
          <span className="text-sm text-muted-foreground">{labels.done}</span>
        )}
        {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        {!pending && (
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/60 transition-transform",
              expanded && "rotate-90"
            )}
          />
        )}
      </button>

      {expanded && !pending && (
        <div className="ml-3 mt-1 border-l border-muted pl-3 pb-1 overflow-hidden">
          {(() => {
            const previewRenderer = getToolPreview(mcpToolName ?? toolName);
            if (previewRenderer) {
              return previewRenderer(args);
            }
            if (resolvedResult !== undefined) {
              return (
                <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground max-h-48 overflow-y-auto styled-scrollbar">
                  {typeof resolvedResult === "string" ? resolvedResult : JSON.stringify(resolvedResult, null, 2)}
                </pre>
              );
            }
            if (Object.keys(args).length > 0) {
              return (
                <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                  {JSON.stringify(args, null, 2)}
                </pre>
              );
            }
            return null;
          })()}
        </div>
      )}
    </div>
  );
}
