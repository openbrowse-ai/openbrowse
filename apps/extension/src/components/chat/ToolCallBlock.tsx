import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { toolResultStore, toolTabInfoStore } from "@/lib/agent/agent-transport";
import { cn } from "@/lib/utils";
import { resolveMcpToolDisplay } from "./mcp-tool-display";
import { AlertCircle, ChevronRight, Globe, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { CodeResult } from "./tool-results/execute-code";
import { PageScriptResult } from "./tool-results/page-script";
import { PlanResult } from "./tool-results/plan";
import { PythonResult } from "./tool-results/execute-python";
import { DelegateResult } from "./tool-results/delegate";
import {
  GlobResult,
  GrepResult,
  LSResult,
  ReadFileResult,
} from "./tool-results/fs";
import { ScreenshotResult } from "./tool-results/screenshot";
import { ComputerResult } from "./tool-results/computer";
import { NavigateResult } from "./tool-results/navigate";
import { SkillResult } from "./tool-results/skill";
import { InstallSkillResult } from "./tool-results/install-skill";
import { SnapshotResult } from "./tool-results/snapshot";
import { WebFetchResult } from "./tool-results/web-fetch";
import { MemoryResult } from "./tool-results/memory";
import { SelectTabResult } from "./tool-results/select-tab";
import {
  CreateScheduledTaskResult,
  ListScheduledTasksResult,
  UpdateScheduledTaskResult,
} from "./tool-results/scheduled-task";

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
  computer: ({ args, result }) => <ComputerResult args={args} result={result} />,
  navigate: ({ args, result }) => <NavigateResult args={args} result={result} />,
  goBack: ({ args, result }) => <NavigateResult args={args} result={result} />,
  goForward: ({ args, result }) => (
    <NavigateResult args={args} result={result} />
  ),
  executeCode: ({ args, result }) => <CodeResult args={args} result={result} />,
  executeOnPage: ({ args, result }) =>
    // A run that referenced a saved script gets a distinct card (no inline
    // code to show); ad-hoc inline `code` falls back to CodeResult.
    args.scriptRef ? (
      <PageScriptResult args={args} result={result} />
    ) : (
      <CodeResult args={args} result={result} />
    ),
  executePython: ({ args, result }) => <PythonResult args={args} result={result} />,
  proposePlan: ({ args, result }) => <PlanResult args={args} result={result} />,
  selectTab: ({ result, toolCallId }) => (
    <SelectTabResult result={result} toolCallId={toolCallId} />
  ),
  saveMemory: ({ args, result }) => (
    <MemoryResult args={args} result={result} action="save" />
  ),
  updateMemory: ({ args, result }) => (
    <MemoryResult args={args} result={result} action="update" />
  ),
  Read: ({ args, result }) => <ReadFileResult args={args} result={result} />,
  Glob: ({ args, result }) => <GlobResult args={args} result={result} />,
  Grep: ({ args, result }) => <GrepResult args={args} result={result} />,
  LS: ({ args, result }) => <LSResult args={args} result={result} />,
  skill: ({ args, result }) => <SkillResult args={args} result={result} />,
  install_skill: ({ result }) => <InstallSkillResult result={result} />,
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
  create_scheduled_task: ({ args, result }) => (
    <CreateScheduledTaskResult args={args} result={result} />
  ),
  list_scheduled_tasks: ({ args, result }) => (
    <ListScheduledTasksResult args={args} result={result} />
  ),
  update_scheduled_task: ({ args, result }) => (
    <UpdateScheduledTaskResult args={args} result={result} />
  ),
};

interface ToolCallBlockProps {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  state: "call" | "result" | "denied" | "errored";
  /** Surfaced when `state === "errored"` (e.g. heal-time errorText). */
  errorText?: string;
  /**
   * Distinguishes a genuine tool failure (`"failed"` → red "Failed" badge)
   * from a turn-interruption / orphaned call (`"interrupted"` → muted
   * "Interrupted" badge). Only meaningful when `state === "errored"`.
   * Defaults to `"interrupted"` when omitted (the historical behavior).
   */
  errorKind?: "failed" | "interrupted";
}

const TOOL_LABELS: Record<
  string,
  {
    pending: string;
    done: string;
    /**
     * Suffix appended after a strikethrough'd `done` label in the
     * denied row (default behavior for all tools). E.g. `done: "Ran
     * Python"` + `denied: "Network blocked"` → `~~Ran Python~~ Network
     * blocked`. Defaults to "Denied" when absent.
     */
    denied?: string;
    /**
     * Full replacement label for the denied row. When set, the denied
     * row renders this text WITHOUT strikethrough and WITHOUT a suffix
     * — i.e. the label IS the outcome message. Used when the strikethrough
     * convention reads as self-contradictory: e.g. `proposePlan`'s
     * `done` is "Plan approved", which strikethrough'd reads as "the
     * plan wasn't approved" — technically correct but confusing. With
     * `deniedReplace: "Make changes requested"` the row simply reads
     * "Make changes requested" — the user's actual decision.
     */
    deniedReplace?: string;
  }
> = {
  readPage: { pending: "Reading page...", done: "Read page" },
  screenshot: { pending: "Taking screenshot...", done: "Took screenshot" },
  snapshot: { pending: "Taking snapshot...", done: "Took snapshot" },
  computer: { pending: "Using computer...", done: "Used computer" },
  listTabs: { pending: "Listing tabs...", done: "Listed tabs" },
  navigate: { pending: "Navigating...", done: "Navigated" },
  goBack: { pending: "Going back...", done: "Went back" },
  goForward: { pending: "Going forward...", done: "Went forward" },
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
  Delete: { pending: "Deleting...", done: "Deleted" },
  todoWrite: { pending: "Updating plan...", done: "Updated plan" },
  proposePlan: {
    pending: "Drafting plan...",
    done: "Plan approved",
    // Use `deniedReplace` (not `denied` suffix) so the row reads
    // "Make changes requested" cleanly instead of the confusing
    // strikethrough'd "~~Plan approved~~ Make changes requested".
    deniedReplace: "Make changes requested",
  },
  extract: { pending: "Extracting data...", done: "Extracted data" },
  webFetch: { pending: "Fetching URL...", done: "Fetched URL" },
  closeTabs: { pending: "Closing tabs...", done: "Closed tabs" },
  read_network_requests: { pending: "Reading network...", done: "Read network" },
  read_console_messages: { pending: "Reading console...", done: "Read console" },

  // Memory tools
  saveMemory: { pending: "Saving memory...", done: "Saved memory" },
  updateMemory: { pending: "Updating memory...", done: "Updated memory" },
  deleteMemory: { pending: "Deleting memory...", done: "Deleted memory" },
  recallMemory: { pending: "Searching memory...", done: "Searched memory" },

  // Skill tools
  skill: { pending: "Loading skill...", done: "Loaded skill" },
  create_skill: { pending: "Creating skill...", done: "Created skill" },
  install_skill: { pending: "Installing skill...", done: "Installed skill" },
  patch_site_skill: { pending: "Updating site skill...", done: "Updated site skill" },
  delete_site_skill: { pending: "Deleting site skill...", done: "Deleted site skill" },

  // Scheduled task tools
  create_scheduled_task: {
    pending: "Scheduling task...",
    done: "Scheduled task",
  },
  list_scheduled_tasks: {
    pending: "Listing scheduled tasks...",
    done: "Listed scheduled tasks",
  },
  update_scheduled_task: {
    pending: "Updating scheduled task...",
    done: "Updated scheduled task",
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
  "read_network_requests",
  "read_console_messages",
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

/**
 * Static, action-specific status text for the CUA `computer` tool, derived
 * from `args.action` (the Anthropic computer-tool action). Without this the
 * row would just read the generic "Used computer".
 */
export function computerLabels(
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const action = typeof args.action === "string" ? args.action : "";
  const coord = Array.isArray(args.coordinate) ? args.coordinate : null;
  const at =
    coord && coord.length === 2 ? ` at (${coord[0]}, ${coord[1]})` : "";
  switch (action) {
    case "screenshot":
      return { pending: "Taking screenshot...", done: "Took screenshot" };
    case "left_click":
      return { pending: `Clicking${at}...`, done: `Clicked${at}` };
    case "right_click":
      return { pending: `Right-clicking${at}...`, done: `Right-clicked${at}` };
    case "middle_click":
      return { pending: `Middle-clicking${at}...`, done: `Middle-clicked${at}` };
    case "double_click":
      return { pending: `Double-clicking${at}...`, done: `Double-clicked${at}` };
    case "triple_click":
      return { pending: `Triple-clicking${at}...`, done: `Triple-clicked${at}` };
    case "left_click_drag":
      return { pending: "Dragging...", done: "Dragged" };
    case "mouse_move":
      return { pending: `Moving cursor${at}...`, done: `Moved cursor${at}` };
    case "type": {
      const t = typeof args.text === "string" ? args.text : "";
      const preview = t.length > 24 ? `${t.slice(0, 23)}…` : t;
      return {
        pending: preview ? `Typing "${preview}"...` : "Typing...",
        done: preview ? `Typed "${preview}"` : "Typed",
      };
    }
    case "key": {
      const k = typeof args.text === "string" ? args.text : "";
      return {
        pending: k ? `Pressing ${k}...` : "Pressing key...",
        done: k ? `Pressed ${k}` : "Pressed key",
      };
    }
    case "scroll": {
      const dir =
        typeof args.scroll_direction === "string" ? args.scroll_direction : "";
      return {
        pending: dir ? `Scrolling ${dir}...` : "Scrolling...",
        done: dir ? `Scrolled ${dir}` : "Scrolled",
      };
    }
    case "wait":
      return { pending: "Waiting...", done: "Waited" };
    case "cursor_position":
      return { pending: "Reading cursor...", done: "Read cursor position" };
    default:
      return fallback;
  }
}

/**
 * Refine the closeTabs collapsed-row label from its args so the user sees
 * what's being closed (e.g. "Closing 2 tabs..." / "Closed 2 tabs", or
 * "Closing tab group...") instead of the generic "Closing tabs...".
 */
export function closeTabsLabels(
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  if (args.target === "group") {
    return { pending: "Closing tab group...", done: "Closed tab group" };
  }
  if (args.target === "tabs") {
    const n = Array.isArray(args.handles) ? args.handles.length : 0;
    if (n > 0) {
      const noun = n === 1 ? "tab" : "tabs";
      return { pending: `Closing ${n} ${noun}...`, done: `Closed ${n} ${noun}` };
    }
  }
  return fallback;
}

/**
 * Refine the create/update scheduled-task labels with the task name so the
 * collapsed row shows what's being scheduled (e.g. "Scheduling
 * 'daily-briefing'..." / "Scheduled 'daily-briefing'") instead of the
 * generic label.
 */
export function scheduledTaskLabels(
  toolName: string,
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (toolName === "create_scheduled_task") {
    if (name) {
      return {
        pending: `Scheduling “${name}”...`,
        done: `Scheduled “${name}”`,
      };
    }
    return fallback;
  }
  if (toolName === "update_scheduled_task") {
    // Distinguish pause/resume from a general edit when possible.
    if (typeof args.enabled === "boolean") {
      const verbing = args.enabled ? "Resuming" : "Pausing";
      const verbed = args.enabled ? "Resumed" : "Paused";
      const label = name ? `“${name}”` : "scheduled task";
      return {
        pending: `${verbing} ${label}...`,
        done: `${verbed} ${label}`,
      };
    }
    if (name) {
      return {
        pending: `Updating “${name}”...`,
        done: `Updated “${name}”`,
      };
    }
    return fallback;
  }
  return fallback;
}

/**
 * Refine the `Delete` label with the target's basename so the collapsed row
 * shows what's being removed (e.g. "Deleting `extract-comments`..." / "Deleted
 * `extract-comments`") instead of the generic "Deleting...".
 */
export function deleteLabels(
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return fallback;
  const base = (path.replace(/\/+$/, "").split("/").pop() || path).replace(
    /\.js$/,
    "",
  );
  if (!base) return fallback;
  return {
    pending: `Deleting \`${base}\`...`,
    done: `Deleted \`${base}\``,
  };
}

/**
 * Refine the `patch_site_skill` / `delete_site_skill` labels with the domain
 * so the collapsed row reads e.g. "Updated site skill `linkedin.com`".
 */
export function siteSkillLabels(
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const domain = typeof args.domain === "string" ? args.domain.trim() : "";
  if (!domain) return fallback;
  // fallback.done is "Updated site skill" / "Deleted site skill"; splice in the
  // domain after the verb phrase.
  return {
    pending: `${fallback.pending.replace(/\.\.\.$/, "")} \`${domain}\`...`,
    done: `${fallback.done} \`${domain}\``,
  };
}

/**
 * Refine the `executeOnPage` label so a by-reference run of a SAVED script
 * reads as "Ran `<name>`" (the script name in code style) instead of the
 * generic "Ran code". Ad-hoc inline `code` runs keep the fallback.
 */
export function executeOnPageLabels(
  args: Record<string, unknown>,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const ref = args.scriptRef as { script?: unknown } | undefined;
  const script = typeof ref?.script === "string" ? ref.script.trim() : "";
  if (!script) return fallback;
  return {
    pending: `Running \`${script}\`...`,
    done: `Ran \`${script}\``,
  };
}

export function ToolCallBlock({
  toolName,
  toolCallId,
  args,
  result,
  state,
  errorText,
  errorKind,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const pending = state === "call";
  const denied = state === "denied";
  const errored = state === "errored";
  const resolvedResult = result ?? toolResultStore.get(toolCallId);
  const { mcpInfo, readableName, readableNameSentence } =
    resolveMcpToolDisplay(toolName);
  const connectorLabels =
    mcpInfo?.connector.formatLabel?.(mcpInfo.toolName, resolvedResult) ?? null;
  const labels: {
    pending: string;
    done: string;
    denied?: string;
    deniedReplace?: string;
  } =
    TOOL_LABELS[toolName] ??
    connectorLabels ?? {
      pending: readableName ? `Running ${readableName}...` : `${toolName}...`,
      done: readableNameSentence ? readableNameSentence : toolName,
    };

  // For webFetch, splice in the requested URL's host so the collapsed
  // row shows the user something concrete (e.g. "Fetching openbrowse.ai...")
  // rather than a generic "Fetching URL...".
  const dynamicLabels =
    toolName === "webFetch"
      ? webFetchLabels(args, labels)
      : toolName === "computer"
        ? computerLabels(args, labels)
        : toolName === "closeTabs"
          ? closeTabsLabels(args, labels)
          : toolName === "create_scheduled_task" ||
              toolName === "update_scheduled_task"
            ? scheduledTaskLabels(toolName, args, labels)
            : toolName === "Delete"
              ? deleteLabels(args, labels)
              : toolName === "executeOnPage"
                ? executeOnPageLabels(args, labels)
                : toolName === "patch_site_skill" ||
                    toolName === "delete_site_skill"
                  ? siteSkillLabels(args, labels)
                  : labels;

  const showTabBadge = TAB_TOOLS.has(toolName);

  // Denied row. Two render shapes (per-tool config in TOOL_LABELS):
  //
  //   - default / `denied` suffix: strikethrough'd `done` label + a
  //     muted suffix (e.g. `~~Ran Python~~ Denied`). The strikethrough
  //     conveys "this didn't happen"; the suffix says why.
  //
  //   - `deniedReplace`: the entry-provided string IS the row label,
  //     no strikethrough, no suffix. Used when the strikethrough'd
  //     `done` label reads as self-contradictory — e.g. proposePlan's
  //     `done: "Plan approved"` with strikethrough reads as "the plan
  //     wasn't approved" (technically true, visually confusing). The
  //     replace shape just shows "Make changes requested" — the
  //     user's actual decision.
  //
  // Both read the labels from the original `labels` object, not
  // `dynamicLabels` (the per-tool helpers like webFetchLabels only
  // re-shape pending/done; they don't customize denied).
  if (denied) {
    if (labels.deniedReplace) {
      return (
        <div className="flex items-center gap-1.5 py-0.5 px-1 -mx-1 text-sm">
          <X className="size-3 shrink-0 text-muted-foreground/60" />
          <span className="text-muted-foreground/70">
            {labels.deniedReplace}
          </span>
          {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        </div>
      );
    }
    const deniedSuffix = labels.denied ?? "Denied";
    return (
      <div className="flex items-center gap-1.5 py-0.5 px-1 -mx-1 text-sm">
        <X className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="text-muted-foreground/70 line-through">
          {dynamicLabels.done}
        </span>
        {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        <span className="text-[11px] text-muted-foreground/60 ml-1">
          {deniedSuffix}
        </span>
      </div>
    );
  }

  // Errored: compact non-expandable row. Two flavors:
  //  - "failed" (a real `output-error`: the tool ran and threw / returned
  //    an error, e.g. an MCP connector tool that got bad JSON) → red X +
  //    red "Failed" badge.
  //  - "interrupted" (the result never arrived because the turn ended /
  //    the call was orphaned, healed via errorText) → muted X + muted
  //    "Interrupted" badge. This is the default when `errorKind` is absent.
  // The `delegate` tool bypasses this branch because its custom renderer
  // (DelegateResult) handles errored state itself — falling through here
  // would render the raw `delegate` label instead of the SubagentTrace.
  if (errored && toolName !== "delegate") {
    const isFailed = errorKind === "failed";
    return (
      <div className="flex items-center gap-1.5 py-0.5 px-1 -mx-1 text-sm">
        <X
          className={cn(
            "size-3 shrink-0",
            isFailed ? "text-destructive" : "text-destructive/70",
          )}
        />
        <span className="text-muted-foreground/70 line-through">
          {dynamicLabels.done}
        </span>
        {showTabBadge && <TabBadge toolCallId={toolCallId} />}
        <span
          className={cn(
            "text-[11px] ml-1",
            isFailed
              ? "text-red-600/70 dark:text-red-400/70"
              : "text-muted-foreground/60",
          )}
          title={errorText}
        >
          {isFailed ? "Failed" : "Interrupted"}
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
