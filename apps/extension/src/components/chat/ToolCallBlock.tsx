import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { toolResultStore, toolTabInfoStore } from "@/lib/agent/agent-transport";
import { getMcpRegistry } from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { getConnectorForMcpTool } from "@openbrowse/connectors";
import { AlertCircle, ChevronRight, Globe, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { CodeResult } from "./tool-results/execute-code";
import { PythonResult } from "./tool-results/execute-python";
import { DelegateResult } from "./tool-results/delegate";
import {
  GlobResult,
  GrepResult,
  LSResult,
  ReadFileResult,
} from "./tool-results/fs";
import { ScreenshotResult } from "./tool-results/screenshot";
import { SkillResult } from "./tool-results/skill";
import { SnapshotResult } from "./tool-results/snapshot";
import { WebFetchResult } from "./tool-results/web-fetch";

import { getToolPreview } from "./tool-previews";

type ResultRenderer = (props: {
  args: Record<string, unknown>;
  result: unknown;
  toolCallId: string;
  /**
   * The underlying part state. Most renderers don't need it, but the
   * `delegate` renderer uses it to distinguish a still-running call
   * (`input-available`) from one that was healed after the parent
   * stream errored (`errored`).
   */
  state?: "call" | "result" | "denied" | "errored";
  /** Heal/error message attached when `state === "errored"`. */
  errorText?: string;
}) => ReactNode;

const BUILTIN_RESULT_RENDERERS: Record<string, ResultRenderer> = {
  snapshot: ({ result }) => <SnapshotResult result={result} />,
  screenshot: ({ result }) => <ScreenshotResult result={result} />,
  executeCode: ({ args, result }) => <CodeResult args={args} result={result} />,
  executeOnPage: ({ args, result }) => (
    <CodeResult args={args} result={result} />
  ),
  executePython: ({ args, result }) => <PythonResult args={args} result={result} />,
  Read: ({ args, result }) => <ReadFileResult args={args} result={result} />,
  Glob: ({ args, result }) => <GlobResult args={args} result={result} />,
  Grep: ({ args, result }) => <GrepResult args={args} result={result} />,
  LS: ({ args, result }) => <LSResult args={args} result={result} />,
  skill: ({ args, result }) => <SkillResult args={args} result={result} />,
  delegate: ({ args, result, toolCallId, state, errorText }) => (
    <DelegateResult
      args={args}
      result={result}
      toolCallId={toolCallId}
      state={state}
      errorText={errorText}
    />
  ),
  webFetch: ({ args, result }) => <WebFetchResult args={args} result={result} />,
};

interface ToolCallBlockProps {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  state: "call" | "result" | "denied" | "errored";
  /** Surfaced when `state === "errored"` (e.g. heal-time errorText). */
  errorText?: string;
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
  executeOnPage: { pending: "Running code...", done: "Ran code" },
  executePython: { pending: "Running Python...", done: "Ran Python" },
  Read: { pending: "Reading file...", done: "Read file" },
  Write: { pending: "Saving file...", done: "Saved file" },
  Edit: { pending: "Editing file...", done: "Edited file" },
  Glob: { pending: "Finding files...", done: "Found files" },
  Grep: { pending: "Searching...", done: "Searched" },
  LS: { pending: "Listing folder...", done: "Listed folder" },
  todoWrite: { pending: "Updating plan...", done: "Updated plan" },
  extract: { pending: "Extracting data...", done: "Extracted data" },
  webFetch: { pending: "Fetching URL...", done: "Fetched URL" },

  // Skill tools
  skill: { pending: "Loading skill...", done: "Loaded skill" },
  create_skill: { pending: "Creating skill...", done: "Created skill" },
  install_skill: { pending: "Installing skill...", done: "Installed skill" },
  read_opfs_file: {
    pending: "Reading bundled file...",
    done: "Read bundled file",
  },

  // (No `delegate` entry — `delegate` bypasses the outer ToolCallBlock
  // wrapper entirely; SubagentTrace renders the whole UI itself.)
};

const TAB_TOOLS = new Set([
  "readPage",
  "screenshot",
  "navigate",
  "clickElement",
  "typeInElement",
  "scrollPage",
  "selectTab",
  "executeOnPage",
  "snapshot",
]);

export function TabBadge({ toolCallId }: { toolCallId: string }) {
  const info = toolTabInfoStore.get(toolCallId);
  if (!info) return null;

  const truncatedTitle =
    info.title.length > 24 ? info.title.slice(0, 22) + "…" : info.title;

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
        <img
          src={info.favIconUrl}
          alt=""
          className="size-3 shrink-0 rounded-sm"
        />
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

/**
 * Build a webFetch-specific label that includes the request URL's host
 * (and path if short enough). Falls back to the static label when the
 * URL isn't usable.
 */
function webFetchLabels(
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const raw = typeof args.url === "string" ? args.url : "";
  if (!raw) return fallback;
  let target = raw;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    target = u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
    if (target.length > 48) target = target.slice(0, 47) + "…";
  } catch {
    // Keep the raw string if the URL was unparseable; the agent's
    // wrapper validates URLs but render shouldn't crash on bad input.
    if (target.length > 48) target = target.slice(0, 47) + "…";
  }
  return {
    pending: `Fetching ${target}...`,
    done: `Fetched ${target}`,
  };
}

export function ToolCallBlock({
  toolName,
  toolCallId,
  args,
  result,
  state,
  errorText,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const pending = state === "call";
  const denied = state === "denied";
  const errored = state === "errored";
  const resolvedResult = result ?? toolResultStore.get(toolCallId);
  const serverIdMatch = toolName.match(/^mcp_([^_]+)_/);
  const serverUrl = serverIdMatch
    ? getMcpRegistry()
        .getStates()
        .find((s) => s.config.id === serverIdMatch[1])?.config.url
    : undefined;
  const mcpInfo = getConnectorForMcpTool(toolName, serverUrl);
  const mcpName = mcpInfo
    ? mcpInfo.toolName.replace(/_/g, " ").replace(/-/g, " ")
    : parseMcpToolName(toolName);
  const connectorLabels =
    mcpInfo?.connector.formatLabel?.(mcpInfo.toolName, resolvedResult) ?? null;
  const labels = TOOL_LABELS[toolName] ??
    connectorLabels ?? {
      pending: mcpName ? `Running ${mcpName}...` : `${toolName}...`,
      done: mcpName ? mcpName : toolName,
    };

  // For webFetch, splice in the requested URL's host so the collapsed
  // row shows the user something concrete (e.g. "Fetching openbrowse.ai...")
  // rather than a generic "Fetching URL...".
  const dynamicLabels =
    toolName === "webFetch" ? webFetchLabels(args, labels) : labels;

  const showTabBadge = TAB_TOOLS.has(toolName);

  // Denied: compact non-expandable row with a muted "Denied" suffix
  if (denied) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 px-1 -mx-1 text-sm">
        <X className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="text-muted-foreground/70 line-through">
          {dynamicLabels.done}
        </span>
        {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        <span className="text-[11px] text-muted-foreground/60 ml-1">
          Denied
        </span>
      </div>
    );
  }

  // Errored: tool call was healed because its result never arrived
  // (parent stream interrupted). Compact non-expandable row showing
  // the heal errorText. The `delegate` tool bypasses this branch
  // because its custom renderer (DelegateResult) handles errored
  // state itself — falling through here would render the raw
  // `delegate` label instead of the SubagentTrace.
  if (errored && toolName !== "delegate") {
    return (
      <div className="flex items-center gap-1.5 py-0.5 px-1 -mx-1 text-sm">
        <X className="size-3 shrink-0 text-destructive/70" />
        <span className="text-muted-foreground/70 line-through">
          {dynamicLabels.done}
        </span>
        {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        <span
          className="text-[11px] text-muted-foreground/60 ml-1"
          title={errorText}
        >
          Interrupted
        </span>
      </div>
    );
  }

  // Resolve custom renderer: built-in map first, then connector's renderResult
  const builtinRenderer = BUILTIN_RESULT_RENDERERS[toolName];
  const mcpToolName = mcpInfo?.toolName;
  const connectorRenderer = mcpInfo?.connector.renderResult;
  const customRenderer: ResultRenderer | undefined =
    builtinRenderer ??
    (connectorRenderer && mcpToolName
      ? ({ result }) => connectorRenderer(mcpToolName, result)
      : undefined);

  // `delegate` is fully self-rendered: SubagentTrace IS the trigger +
  // content. Wrapping it in another Collapsible/trigger row would
  // double-stack chevrons and surface a misleading SDK-state label
  // ("Subagent finished" / "Delegating to subagent...") above a trace
  // whose own pill may say something different. Bypass the outer
  // wrapper entirely — the custom renderer handles all states.
  if (toolName === "delegate" && customRenderer) {
    const rendered = customRenderer({
      args,
      result: resolvedResult,
      toolCallId,
      state,
      errorText,
    });
    if (rendered !== null) {
      return <>{rendered}</>;
    }
  }

  // Tools with custom renderers: always-expanded when done
  if (customRenderer && !pending && resolvedResult) {
    const rendered = customRenderer({
      args,
      result: resolvedResult,
      toolCallId,
    });
    if (rendered !== null) {
      return (
        <Collapsible
          open={expanded}
          onOpenChange={setExpanded}
          className="flex flex-col w-full"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 py-0.5 cursor-pointer rounded-sm hover:bg-accent/50 transition-colors px-1 -mx-1 text-left"
            >
              {mcpInfo ? (
                <RegistryIcon
                  id={mcpInfo.connector.id}
                  className="size-3.5 shrink-0"
                />
              ) : errored ? (
                <AlertCircle className="size-3 shrink-0 text-red-500/80" />
              ) : (
                <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground/40" />
              )}
              <span
                className={cn(
                  "text-sm",
                  errored ? "text-red-600/90 dark:text-red-400/90" : "text-muted-foreground",
                )}
              >
                {dynamicLabels.done}
              </span>
              {errored && (
                <span className="text-[11px] text-red-600/70 dark:text-red-400/70 ml-1">
                  Failed
                </span>
              )}
              {showTabBadge && <TabBadge toolCallId={toolCallId} />}
              <ChevronRight
                className={cn(
                  "size-3 text-muted-foreground/60 transition-transform",
                  expanded && "rotate-90",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            {rendered}
          </CollapsibleContent>
        </Collapsible>
      );
    }
  }

  // Default: collapsible with JSON fallback
  return (
    <Collapsible
      open={expanded && !pending}
      onOpenChange={(open) => !pending && setExpanded(open)}
      className="flex flex-col w-full"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 py-0.5 text-left",
            !pending &&
              "cursor-pointer rounded-sm hover:bg-accent/50 transition-colors px-1 -mx-1",
          )}
          disabled={pending}
        >
          {mcpInfo ? (
            <RegistryIcon
              id={mcpInfo.connector.id}
              className="size-3.5 shrink-0"
            />
          ) : errored ? (
            <AlertCircle className="size-3 shrink-0 text-red-500/80" />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                pending
                  ? "bg-blue-500 animate-pulse"
                  : "bg-muted-foreground/40",
              )}
            />
          )}
          {pending ? (
            <span
              className={cn(
                "text-sm text-muted-foreground",
                !mcpInfo && "animate-pulse",
              )}
            >
              {dynamicLabels.pending}
            </span>
          ) : (
            <span
              className={cn(
                "text-sm",
                errored
                  ? "text-red-600/90 dark:text-red-400/90"
                  : "text-muted-foreground",
              )}
            >
              {dynamicLabels.done}
            </span>
          )}
          {errored && (
            <span className="text-[11px] text-red-600/70 dark:text-red-400/70 ml-1">
              Failed
            </span>
          )}
          {showTabBadge && <TabBadge toolCallId={toolCallId} />}
          {!pending && (
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground/60 transition-transform",
                expanded && "rotate-90",
              )}
            />
          )}
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="ml-3 mt-1 border-l border-muted pl-3 pb-1">
          {(() => {
            const previewRenderer = getToolPreview(mcpToolName ?? toolName);
            if (previewRenderer) {
              return previewRenderer(args);
            }
            if (resolvedResult !== undefined) {
              return (
                <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground max-h-48 overflow-y-auto styled-scrollbar">
                  {typeof resolvedResult === "string"
                    ? resolvedResult
                    : JSON.stringify(resolvedResult, null, 2)}
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
      </CollapsibleContent>
    </Collapsible>
  );
}
