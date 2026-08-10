import { z } from "zod";
import type { ToolContext } from "../driver";
import type { BrowserTool } from "../types";
import {
  BATCH_TOOL_NAME,
  type BatchInvocationResult,
  type BatchOutput,
  normalizeInvocationArguments,
  readInBandError,
} from "./batch-args";
import { extractTool } from "./extract";
import { createFsTools } from "./fs";
import { listArtifactsTool } from "./list-artifacts";
import { listTabsTool } from "./list-tabs";
import { readArtifactDiagnosticsTool } from "./read-artifact-diagnostics";
import { readConsoleMessagesTool } from "./read-console-messages";
import { readNetworkRequestsTool } from "./read-network-requests";
import { readPageTool } from "./read-page";
import { searchMemoryTool } from "./search-memory";
import { skillTool } from "./skill";
import { snapshotTool } from "./snapshot";
import { webSearchTool } from "./web-search";

/**
 * `batch` — run several INDEPENDENT read-only tools in one tool call.
 *
 * Why this exists: the AI SDK already executes multiple tool-call parts
 * from a single step concurrently, so the win here is not raw
 * concurrency — it's collapsing N `tool_use` blocks into one for models
 * that won't reliably emit native parallel calls, and cutting the output
 * tokens spent restating shared arguments.
 *
 * ## Why read-only, and why an explicit registry
 *
 * Every safety decision in this codebase lives in `toSDKTool`
 * (`../agent-transport.ts`), NOT in the tools themselves: approval-mode
 * dispatch (ask/plan/act), the per-site "Always allow on <site>"
 * allowlist, `executeOnPage`'s static read check, `executePython`'s
 * network gate, and `closeTabs` auto-approve are all wrapper-level. A
 * batch tool calls `tool.execute()` directly and therefore bypasses all
 * of it.
 *
 * Rather than duplicate (or refactor) that gating, `batch` only accepts
 * tools that need none of it. Every entry in the registry must be:
 *
 *   1. **Approval-free** — `approval?.required !== true`. Enforced by a
 *      unit test so a future `approval: { required: true }` on a
 *      batchable tool fails CI instead of silently becoming an approval
 *      bypass.
 *   2. **Side-effect-free** — no clicks, typing, navigation, form
 *      submission, filesystem writes, or tab lifecycle changes. Parallel
 *      writes against one tab would also race on the shared CDP session
 *      and the snapshot ref-store.
 *   3. **Not image-bearing** — `screenshot` is deliberately excluded.
 *      Compaction identifies strippable images by `part.toolName`
 *      (`STRIPPABLE_IMAGE_TOOLS` / `PAGE_SCREENSHOT_TOOLS` in
 *      `../compaction.ts`), so a screenshot nested under
 *      `toolName: "batch"` would never be stripped and would grow
 *      context without bound.
 *
 * Anything else must be called directly. Unknown/disallowed names return
 * a per-invocation error saying exactly that, rather than failing the
 * whole batch.
 *
 * ## Scoping for subagents
 *
 * `createBatchTool` takes its registry as an argument precisely so a
 * caller with a narrower toolset can hand over a narrower registry.
 * Subagents filter tools by `allowedTools`, so handing them the full
 * registry would let `batch` reach tools the agent definition denied.
 * The subagent runner in `../agent-transport.ts` rebuilds `batch` with
 * the intersection of {@link buildBatchableRegistry} and the agent's
 * allow/deny lists.
 */

export type { BatchInvocationResult, BatchOutput } from "./batch-args";

/** Erased tool shape — the registry is heterogeneous by construction. */
type AnyBrowserTool = BrowserTool<any, unknown>;

/** Hard cap on invocations per call. Keeps one batch's output bounded. */
export const MAX_INVOCATIONS = 8;

/** Minimum invocations. One invocation should just be a direct call. */
export const MIN_INVOCATIONS = 2;

/**
 * How many invocations run at once.
 *
 * Equal to {@link MAX_INVOCATIONS}, so in practice nothing is throttled:
 * a batch runs as one wave. The limiter is kept because it is the honest
 * place to put a ceiling if one turns out to be needed, not because this
 * value is load-bearing.
 *
 * An earlier version capped this at 4 to avoid "starving the page". That
 * reasoning did not hold: `execute` runs in the service worker, and
 * invocations targeting different tabs dispatch into separate renderer
 * processes, so they do not contend with each other or with the page.
 *
 * The real pressure points are rate limits — several concurrent
 * `webSearch` calls hit one hosted proxy, and each `extract` spends an
 * LLM round-trip — plus CDP contention when invocations share a tab. A
 * cap of 4 only halved the odds of tripping those without removing them,
 * while costing up to a second wave of latency on every full batch. If
 * rate limiting shows up in practice, the fix is to back off on the
 * failing call (or cap per-tool), not to slow every batch down.
 */
export const BATCH_CONCURRENCY = MAX_INVOCATIONS;

const invocationSchema = z.object({
  name: z
    .string()
    .describe(
      "Name of the tool to run. Must be one of the batchable tools listed in this tool's description.",
    ),
  arguments: z
    .any()
    .optional()
    .describe(
      "Arguments object for the tool, exactly as you would pass them in a direct call (e.g. {tab: 't1', mode: 'viewport'}). Pass an object literal; omit for no-arg tools.",
    ),
});

const parameters = z.object({
  description: z
    .string()
    .min(1)
    .describe(
      "Short present-participle phrase naming the work these calls accomplish, shown to the user while the batch runs (e.g. \"Comparing pricing pages\", \"Checking release notes\", \"Searching project files\"). Describe the goal in the user's terms, 2-6 words, no trailing punctuation. Do NOT mention tools, batching, parallelism, or counts — the interface adds progress and status itself.",
    ),
  invocations: z
    .array(invocationSchema)
    .min(MIN_INVOCATIONS)
    .max(MAX_INVOCATIONS)
    .describe(
      `Between ${MIN_INVOCATIONS} and ${MAX_INVOCATIONS} independent tool calls. Results come back in this same order.`,
    ),
});

type Input = z.infer<typeof parameters>;

/**
 * The default batchable registry: read-only, approval-free, non-image
 * tools, keyed by the exact name the model uses in a direct call.
 *
 * This map is the single source of truth for "what may be batched" —
 * there is no separate allowlist to drift out of sync with it.
 *
 * `createFsTools()` is a pure factory (object literals, no shared
 * state), so calling it here rather than threading the caller's instance
 * through keeps this function usable standalone.
 */
export function buildBatchableRegistry(): Record<string, AnyBrowserTool> {
  const fs = createFsTools();
  return {
    // Page reads
    snapshot: snapshotTool,
    readPage: readPageTool,
    extract: extractTool,
    read_network_requests: readNetworkRequestsTool,
    read_console_messages: readConsoleMessagesTool,
    listTabs: listTabsTool,
    // Web
    webSearch: webSearchTool,
    // Workspace reads
    Read: fs.readTool,
    Glob: fs.globTool,
    Grep: fs.grepTool,
    LS: fs.lsTool,
    // Knowledge reads. Memory is file-based post-v2: `searchMemory`
    // locates notes and `Read` opens them, which makes "search, then read
    // the top hits" a natural batch.
    searchMemory: searchMemoryTool,
    skill: skillTool,
    list_artifacts: listArtifactsTool,
    read_artifact_diagnostics: readArtifactDiagnosticsTool,
  };
}

/** Tool names the default registry accepts. Exported for tests + docs. */
export const BATCHABLE: readonly string[] = Object.keys(
  buildBatchableRegistry(),
);

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input
 * order in the output. `fn` MUST NOT reject — the caller wraps its own
 * try/catch so one failed invocation can't sink the batch.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        out[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function buildDescription(names: readonly string[]): string {
  return [
    `Run ${MIN_INVOCATIONS}-${MAX_INVOCATIONS} INDEPENDENT read-only tools in a single call.`,
    `Pass a \`description\` naming the work in the user's terms ("Comparing pricing pages") — it is shown in the UI while the calls run.`,
    `Results come back in \`results\`, in the same order as \`invocations\`; each entry is {name, ok, output?, error?}. One failing invocation does not fail the others.`,
    `Batchable tools: ${names.join(", ")}.`,
    `Use it when you already know every argument up front — e.g. reading three tabs, grepping two patterns, or running several webSearch queries.`,
    `Do NOT use it when one call's arguments depend on another's result (an @ref from a snapshot, a URL from a search): invocations run concurrently and cannot see each other's output.`,
    `Everything not listed above — clicking, typing, navigating, screenshots, writes, code execution, anything that needs approval — must be called directly. Batching such a tool returns an error for that invocation.`,
  ].join(" ");
}

/**
 * Build the `batch` tool over an explicit registry of batchable tools.
 *
 * @param registry Tools reachable from inside a batch, keyed by the name
 *   the model uses. Defaults to {@link buildBatchableRegistry}. Callers
 *   with a restricted toolset (subagents) MUST pass a narrowed registry —
 *   see the module JSDoc.
 */
export function createBatchTool(
  registry: Record<string, AnyBrowserTool> = buildBatchableRegistry(),
): BrowserTool<Input, BatchOutput> {
  const names = Object.keys(registry);
  return {
    name: BATCH_TOOL_NAME,
    description: buildDescription(names),
    parameters,
    execute: async ({ invocations }, ctx) => {
      const results = await mapWithConcurrency(
        invocations,
        BATCH_CONCURRENCY,
        async (invocation, index): Promise<BatchInvocationResult> => {
          const { name } = invocation;

          // The turn was cancelled (user pressed Stop, parent loop torn
          // down) while earlier invocations were in flight. Report the
          // remainder as skipped rather than throwing, so the results
          // that did complete still reach the model.
          if (ctx.signal?.aborted) {
            return {
              name,
              ok: false,
              error: "Skipped: the run was cancelled before this invocation.",
            };
          }

          const tool = Object.hasOwn(registry, name)
            ? registry[name]
            : undefined;
          if (!tool) {
            return {
              name,
              ok: false,
              error: `"${name}" cannot be batched. Batchable tools: ${names.join(
                ", ",
              )}. Call "${name}" directly instead.`,
            };
          }

          const args = normalizeInvocationArguments(invocation.arguments);
          if (!args.ok) return { name, ok: false, error: args.error };

          const parsed = tool.parameters.safeParse(args.value);
          if (!parsed.success) {
            return {
              name,
              ok: false,
              error: `Invalid arguments for "${name}": ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`,
            };
          }

          try {
            // Sub-scope the toolCallId. `toSDKTool`'s per-call stores
            // (`toolResultStore`, `toolTabInfoStore`) and any tool that
            // broadcasts keyed events are keyed by it; without a suffix
            // every invocation in the batch would clobber the same key.
            const childCtx: ToolContext = {
              ...ctx,
              ...(ctx.toolCallId && {
                toolCallId: `${ctx.toolCallId}:${index}`,
              }),
            };
            const output = await tool.execute(parsed.data, childCtx);
            // A tool that reports failure in its payload rather than by
            // throwing (e.g. `webSearch` → `{ results: [], error }`) did
            // not produce usable data, so it must not be counted as a
            // success. Keep `output` so the model — and the child's own
            // result card — still see the detail.
            const inBandError = readInBandError(output);
            if (inBandError) {
              return { name, ok: false, error: inBandError, output };
            }
            return { name, ok: true, output };
          } catch (err) {
            return {
              name,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      );
      return { results };
    },
  };
}
