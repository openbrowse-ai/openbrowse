/**
 * Public API surface for `@openbrowse/bench`.
 *
 * Out-of-tree harness files import everything they need from this barrel —
 * `defineHarness`, the `BrowserTool`/`ToolContext` authoring types, and the
 * `captureViewPage` perception primitive — so they never reach into
 * openbrowse-internal `@agent/*` paths. The bench CLI resolves this module
 * via the `@openbrowse/bench` tsconfig path alias when it dynamic-imports a
 * harness (spike-verified for out-of-tree resolution).
 */

// Trial + sweep orchestration
export { runTrial, type TrialConfig, type TrialResult, type TraceEntry } from "./runner";
export { runBench, BenchConfigError, type BenchConfig, type BenchSummary } from "./bench";

// Harness contract
export {
  defineHarness,
  defineTool,
  loadHarnessFromFile,
  DEFAULT_PAGE_STATE_FIELDS,
  DEFAULT_PAGE_STATE_IMAGE_TOOLS,
  BUILT_IN_SUBAGENT_SLUGS,
  type Harness,
  type SubagentDef,
  type SubagentEntry,
  type BuiltInSubagentSlug,
  type AnyBrowserTool,
} from "./harness";

// Perception primitive for SoM-style harnesses
export {
  captureViewPage,
  type CapturedView,
  type CaptureViewOptions,
} from "./agent/som-capture";

// No-harness defaults / catalog (useful for composing custom tool sets)
export {
  BENCH_TOOL_CATALOG,
  DEFAULT_TOOL_SET,
  buildBenchSystemPrompt,
  type BenchToolName,
} from "./agent/build-agent";

// Tool-authoring types (re-exported so harnesses avoid @agent/* directly)
export type { BrowserTool } from "@agent/types";
export type { ToolContext } from "@agent/driver";
