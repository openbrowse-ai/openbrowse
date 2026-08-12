import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { toolResultStore, toolTabInfoStore } from "@/lib/agent/agent-transport";
import {
  readBatchDescription,
  readBatchInvocations,
  readBatchResults,
} from "@/lib/agent/tools/batch-args";
import { cn } from "@/lib/utils";
import { AlertCircle, ChevronRight, Globe, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveMcpToolDisplay } from "./mcp-tool-display";
import { ArtifactResult } from "./tool-results/artifact";
import { ArtifactDiagnosticsResult } from "./tool-results/artifact-diagnostics";
import { ComputerResult } from "./tool-results/computer";
import { BatchResult } from "./tool-results/batch";
import { DelegateResult } from "./tool-results/delegate";
import { CodeResult } from "./tool-results/execute-code";
import { PythonResult } from "./tool-results/execute-python";
import {
  GlobResult,
  GrepResult,
  LSResult,
  ReadFileResult,
} from "./tool-results/fs";
import { InstallSkillResult } from "./tool-results/install-skill";
import { SearchMemoryResult } from "./tool-results/memory";
import { NavigateResult } from "./tool-results/navigate";
import { PageScriptResult } from "./tool-results/page-script";
import { PlanResult } from "./tool-results/plan";
import {
  CreateScheduledTaskResult,
  ListScheduledTasksResult,
  UpdateScheduledTaskResult,
} from "./tool-results/scheduled-task";
import { ScreenshotResult } from "./tool-results/screenshot";
import { SelectTabResult } from "./tool-results/select-tab";
import { SkillResult } from "./tool-results/skill";
import { SnapshotResult } from "./tool-results/snapshot";
import { WebFetchResult } from "./tool-results/web-fetch";
import { WebSearchResult } from "./tool-results/web-search";

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
  batch: ({ args, result }) => (
    <BatchResult
      args={args}
      result={result}
      // Reuse each child tool's own result card. `toolCallId` is only
      // read by renderers that subscribe to per-call side channels
      // (`selectTab`, `delegate`), neither of which is batchable, so an
      // empty string is safe here.
      renderChild={(name, childArgs, childResult) =>
        BUILTIN_RESULT_RENDERERS[name]?.({
          args: childArgs,
          result: childResult,
          toolCallId: "",
          state: "result",
        })
      }
      // Reuse each child tool's own row label too, so an invocation reads
      // the same as the call would on its own.
      childLabel={resolveToolLabels}
    />
  ),
  snapshot: ({ result }) => <SnapshotResult result={result} />,
  screenshot: ({ result }) => <ScreenshotResult result={result} />,
  computer: ({ args, result }) => (
    <ComputerResult args={args} result={result} />
  ),
  navigate: ({ args, result }) => (
    <NavigateResult args={args} result={result} />
  ),
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
  executePython: ({ args, result }) => (
    <PythonResult args={args} result={result} />
  ),
  proposePlan: ({ args, result }) => <PlanResult args={args} result={result} />,
  selectTab: ({ result, toolCallId }) => (
    <SelectTabResult result={result} toolCallId={toolCallId} />
  ),
  searchMemory: ({ args, result }) => (
    <SearchMemoryResult args={args} result={result} />
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
  webFetch: ({ args, result }) => (
    <WebFetchResult args={args} result={result} />
  ),
  webSearch: ({ args, result }) => (
    <WebSearchResult args={args} result={result} />
  ),
  create_scheduled_task: ({ args, result }) => (
    <CreateScheduledTaskResult args={args} result={result} />
  ),
  list_scheduled_tasks: ({ args, result }) => (
    <ListScheduledTasksResult args={args} result={result} />
  ),
  update_scheduled_task: ({ args, result }) => (
    <UpdateScheduledTaskResult args={args} result={result} />
  ),
  create_artifact: ({ args, result }) => (
    <ArtifactResult args={args} result={result} />
  ),
  read_artifact_diagnostics: ({ args, result }) => (
    <ArtifactDiagnosticsResult args={args} result={result} />
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

export type ToolLabels = {
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
  /**
   * Short status metadata rendered after the label (e.g. "3 of 4").
   * Owned by the interface, not the model: tools describe WHAT they
   * did, the row reports how it went.
   */
  meta?: string;
  /**
   * Tints `meta` and swaps the leading dot for an alert glyph.
   *
   * `warning` (amber) is for a partial success — some of the work landed,
   * so the row must not read as a failure. `error` (red) is for an
   * outcome that produced nothing usable, matching how `errored` rows
   * render; the two are kept distinct because conflating them tells the
   * user their partial results are gone.
   */
  metaTone?: "muted" | "warning" | "error";
};

const TOOL_LABELS: Record<string, ToolLabels> = {
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
  Move: { pending: "Moving...", done: "Moved" },
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
  batch: { pending: "Running batch...", done: "Ran batch" },
  webFetch: { pending: "Fetching URL...", done: "Fetched URL" },
  webSearch: { pending: "Searching the web...", done: "Searched the web" },
  closeTabs: { pending: "Closing tabs...", done: "Closed tabs" },
  read_network_requests: {
    pending: "Reading network...",
    done: "Read network",
  },
  read_console_messages: {
    pending: "Reading console...",
    done: "Read console",
  },

  // Memory tools
  searchMemory: { pending: "Searching memory...", done: "Searched memory" },

  // Skill tools
  skill: { pending: "Loading skill...", done: "Loaded skill" },
  create_skill: { pending: "Creating skill...", done: "Created skill" },
  install_skill: { pending: "Installing skill...", done: "Installed skill" },
  patch_site_skill: {
    pending: "Updating site skill...",
    done: "Updated site skill",
  },
  delete_site_skill: {
    pending: "Deleting site skill...",
    done: "Deleted site skill",
  },

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

  // Artifact tools
  create_artifact: {
    pending: "Creating artifact...",
    done: "Created artifact",
  },
  update_artifact: {
    pending: "Updating artifact...",
    done: "Updated artifact",
  },
  delete_artifact: {
    pending: "Deleting artifact...",
    done: "Deleted artifact",
  },
  list_artifacts: { pending: "Listing artifacts...", done: "Listed artifacts" },
  read_artifact_diagnostics: {
    pending: "Verifying artifact...",
    done: "Verified artifact",
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
 * Build a webSearch-specific label from the query and (when done) the number
 * of results, so the row reads e.g. `Searching “bio AI startups”...` →
 * `Searched “bio AI startups” — 8 results` instead of a generic "Searched
 * the web".
 */
function webSearchLabels(
  args: Record<string, unknown>,
  result: unknown,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  const raw = typeof args.query === "string" ? args.query.trim() : "";
  if (!raw) return fallback;
  const q = raw.length > 42 ? raw.slice(0, 41) + "…" : raw;
  const out = (result ?? {}) as { results?: unknown[]; error?: unknown };
  if (typeof out.error === "string") {
    return { pending: `Searching “${q}”...`, done: `Search failed: “${q}”` };
  }
  const count = Array.isArray(out.results) ? out.results.length : 0;
  const done =
    count > 0
      ? `Searched “${q}” — ${count} result${count === 1 ? "" : "s"}`
      : `Searched “${q}”`;
  return { pending: `Searching “${q}”...`, done };
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
      return {
        pending: `Middle-clicking${at}...`,
        done: `Middle-clicked${at}`,
      };
    case "double_click":
      return {
        pending: `Double-clicking${at}...`,
        done: `Double-clicked${at}`,
      };
    case "triple_click":
      return {
        pending: `Triple-clicking${at}...`,
        done: `Triple-clicked${at}`,
      };
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
      return {
        pending: `Closing ${n} ${noun}...`,
        done: `Closed ${n} ${noun}`,
      };
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

/**
 * Refine the `read_artifact_diagnostics` done label from its result so the
 * collapsed row tells the verification outcome at a glance ("Rendered cleanly"
 * / "Found 2 errors" / "No render reported") instead of the generic
 * "Verified artifact". Pending stays as-is.
 */
export function artifactDiagnosticsLabels(
  result: unknown,
  fallback: { pending: string; done: string },
): { pending: string; done: string } {
  if (!result || typeof result !== "object") return fallback;
  const r = result as {
    rendered?: unknown;
    errors?: unknown[];
  };
  const errorCount = Array.isArray(r.errors) ? r.errors.length : 0;
  if (errorCount > 0) {
    return {
      ...fallback,
      done: errorCount === 1 ? "Found 1 error" : `Found ${errorCount} errors`,
    };
  }
  if (r.rendered) {
    return { ...fallback, done: "Rendered cleanly" };
  }
  return { ...fallback, done: "No render reported" };
}

/**
 * Collapsed-row labels for `batch`.
 *
 * The model supplies a `description` naming the work in the user's terms
 * ("Comparing pricing pages"); the row keeps that phrase VERBATIM from
 * start to finish and lets the icon plus a trailing count carry the
 * state. Rewriting the phrase into past tense on completion would mean
 * conjugating arbitrary model text — brittle in English and wrong in
 * every other language the user might prompt in.
 *
 * The count is only shown once results exist. `batch` resolves all of
 * its invocations before returning a single aggregate output, so there
 * is no honest mid-flight "2 of 4" to report; while running we state the
 * size of the job instead.
 */
export function batchLabels(
  args: Record<string, unknown>,
  result: unknown,
  fallback: ToolLabels,
): ToolLabels {
  const description = readBatchDescription(args);
  const total = readBatchInvocations(args).length;
  const results = readBatchResults(result);
  const reads = total === 1 ? "1 read" : `${total} reads`;
  // Without a description the label itself carries the count ("Ran 4
  // reads"), so a trailing "4 of 4" would just say it twice.
  const countInLabel = !description;

  // No description (legacy row, or input still streaming): describe the
  // shape of the work rather than showing the raw tool name.
  const pending = description
    ? `${description}...`
    : total > 0
      ? `Running ${reads}...`
      : fallback.pending;
  const done = description
    ? description
    : total > 0
      ? `Ran ${reads}`
      : fallback.done;

  if (results.length === 0) {
    // The tool itself failed, so `toSDKTool` swapped the whole output for
    // `{ error }`. Report that plainly instead of implying 0 of N reads
    // came back clean.
    const topLevelError = (result as { error?: unknown } | null | undefined)
      ?.error;
    if (typeof topLevelError === "string") {
      // Nothing came back at all, so this is a failure and not a partial
      // success — red, like any other errored row.
      return { ...fallback, pending, done, meta: "Failed", metaTone: "error" };
    }
    return {
      ...fallback,
      pending,
      done,
      ...(total > 0 &&
        !countInLabel && { meta: reads, metaTone: "muted" as const }),
    };
  }

  const succeeded = results.filter((r) => r.ok).length;
  const allOk = succeeded === results.length;
  return {
    ...fallback,
    pending,
    done,
    // A clean run needs no tally when the label already counts the reads;
    // a partial one always shows it, because that is the whole point.
    ...(!(countInLabel && allOk) && {
      meta: `${succeeded} of ${results.length}`,
    }),
    metaTone: allOk ? "muted" : "warning",
  };
}

/**
 * The label a tool's collapsed row shows: the tool's static entry (or its
 * MCP connector's) refined by any tool-specific dynamic label function.
 *
 * Returns `undefined` when nothing tool-specific applies, so each caller
 * chooses its own fallback — `ToolCallBlock` shows a generic
 * "Running <name>...", while a batch child row keeps its argument summary
 * instead of degrading to the bare tool name. Every tool with a dynamic
 * label function also has a `TOOL_LABELS` entry, so a missing entry is a
 * sufficient signal that there is nothing specific to say.
 *
 * Exported, and injected into `BatchResult`, so an invocation inside a
 * `batch` reads the same as the same call made directly — `Searched “bio
 * AI startups” — 8 results` rather than `webSearch  query: bio AI
 * startups`. Injected rather than imported for the same reason as
 * `renderChild`: importing this module from `tool-results/batch` would
 * form a cycle.
 */
export function resolveToolLabels(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): ToolLabels | undefined {
  const { mcpInfo } = resolveMcpToolDisplay(toolName);
  const base =
    TOOL_LABELS[toolName] ??
    mcpInfo?.connector.formatLabel?.(mcpInfo.toolName, result) ??
    null;
  if (!base) return undefined;

  return toolName === "batch"
    ? batchLabels(args, result, base)
    : toolName === "webSearch"
      ? webSearchLabels(args, result, base)
      : toolName === "webFetch"
        ? webFetchLabels(args, base)
        : toolName === "computer"
          ? computerLabels(args, base)
          : toolName === "closeTabs"
            ? closeTabsLabels(args, base)
            : toolName === "create_scheduled_task" ||
                toolName === "update_scheduled_task"
              ? scheduledTaskLabels(toolName, args, base)
              : toolName === "Delete"
                ? deleteLabels(args, base)
                : toolName === "executeOnPage"
                  ? executeOnPageLabels(args, base)
                  : toolName === "patch_site_skill" ||
                      toolName === "delete_site_skill"
                    ? siteSkillLabels(args, base)
                    : toolName === "read_artifact_diagnostics"
                      ? artifactDiagnosticsLabels(result, base)
                      : base;
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
  // The tool's static entry. Kept separate from `dynamicLabels` because
  // the denied paths below read `deniedReplace`/`denied` off it — the
  // per-tool helpers only re-shape pending/done.
  const labels: ToolLabels =
    TOOL_LABELS[toolName] ??
    mcpInfo?.connector.formatLabel?.(mcpInfo.toolName, resolvedResult) ?? {
      pending: readableName ? `Running ${readableName}...` : `${toolName}...`,
      done: readableNameSentence ? readableNameSentence : toolName,
    };
  // Tool-specific text where we have it — e.g. webFetch splices in the
  // requested URL's host so the row reads "Fetching openbrowse.ai..."
  // rather than a generic "Fetching URL...". Falls back to the static
  // entry, which is what `resolveToolLabels` returning `undefined` means.
  const dynamicLabels: ToolLabels =
    resolveToolLabels(toolName, args, resolvedResult) ?? labels;

  const showTabBadge = TAB_TOOLS.has(toolName);

  // An outcome that needs an alert glyph rather than the neutral dot:
  // amber for a partial success (some work landed, so the label keeps its
  // normal color), red for one that produced nothing usable.
  const metaTone = dynamicLabels.metaTone;
  const metaAlert = !pending && (metaTone === "warning" || metaTone === "error");
  const metaBadge = dynamicLabels.meta ? (
    <span
      className={cn(
        "text-[11px] ml-1 tabular-nums",
        metaTone === "error"
          ? "text-red-600/70 dark:text-red-400/70"
          : metaTone === "warning"
            ? "text-amber-600/80 dark:text-amber-400/80"
            : "text-muted-foreground/60",
      )}
    >
      {dynamicLabels.meta}
    </span>
  ) : null;
  const metaAlertIcon = (
    <AlertCircle
      className={cn(
        "size-3 shrink-0",
        metaTone === "error" ? "text-red-500/80" : "text-amber-500/80",
      )}
    />
  );

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
              ) : metaAlert ? (
                metaAlertIcon
              ) : (
                <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground/40" />
              )}
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
              {errored && (
                <span className="text-[11px] text-red-600/70 dark:text-red-400/70 ml-1">
                  Failed
                </span>
              )}
              {metaBadge}
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
          ) : metaAlert ? (
            metaAlertIcon
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
          {metaBadge}
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
