/**
 * Harness config — the declarative contract for "what agent are we
 * benchmarking?"
 *
 * A harness file (an out-of-tree config loaded by the bench CLI via
 * `--harness <path>`) describes the agent-under-test: its system prompt,
 * tool inventory, page-state delivery policy, optional subagents, and
 * optional model/thinking/limit defaults.
 *
 * The bench package ships ZERO harnesses. An unconfigured CLI run uses the
 * built-in `DEFAULT_TOOL_SET` + section-stripped prompt — that is "no
 * harness," not a "baseline arm." Experiment-specific arms (SoM, etc.) live
 * out-of-tree (in a separate harness directory) and import this module's
 * `defineHarness` from `@openbrowse/bench`.
 */

import { z } from "zod";
import type { BrowserTool } from "@agent/types";

/**
 * A `BrowserTool` with its input/output types erased to `any`.
 *
 * `Harness.tools` and `BENCH_TOOL_CATALOG` are heterogeneous tool collections,
 * so they need a single element type that any concretely-typed tool is
 * assignable to. `BrowserTool<unknown, unknown>` does NOT work: `TInput`
 * appears contravariantly in `execute(input: TInput, …)` and invariantly in
 * `parameters: z.ZodType<TInput>`, so e.g. `BrowserTool<{site: string}, …>` is
 * not assignable to `BrowserTool<unknown, unknown>` — forcing an
 * `as BrowserTool<unknown, unknown>` cast at every use site. Using `any` makes
 * the type parameters bivariant, so harness authors can drop a concretely-typed
 * tool straight into `tools: [...]` with no cast while still keeping the tool's
 * own definition fully typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBrowserTool = BrowserTool<any, any>;

/**
 * Identity helper for authoring a tool with full input/output inference.
 *
 * Optional sugar mirroring `defineHarness`: gives custom tools a natural home
 * and preserves their concrete `BrowserTool<TInput, TOutput>` type (so the
 * tool's own `execute` body is type-checked) while remaining assignable to
 * `AnyBrowserTool` when added to a harness.
 */
export function defineTool<TInput, TOutput>(
  tool: BrowserTool<TInput, TOutput>,
): BrowserTool<TInput, TOutput> {
  return tool;
}

/** Slugs of the subagents shipped with the openbrowse extension. */
export const BUILT_IN_SUBAGENT_SLUGS = ["explore", "general"] as const;
export type BuiltInSubagentSlug = (typeof BUILT_IN_SUBAGENT_SLUGS)[number];

/**
 * Static definition of a subagent the parent agent can `delegate` to.
 *
 * Mirrors the extension's `AgentDefinition` (apps/extension/.../subagents/
 * types.ts) but lives here so harness authors can declare custom subagents
 * without importing extension internals. The bench's headless subagent
 * runner maps these onto the extension's pure `concurrency`/`types` modules.
 */
export interface SubagentDef {
  /** Stable identifier; used in `delegate({slug})` / `@agent:<slug>`. */
  slug: string;
  /** One-line summary; surfaced in the delegate tool description. */
  description: string;
  /** Routing hint for the parent LLM ("Use this when ..."). */
  whenToUse: string;
  /** Full system prompt for the subagent (fresh-context; no parent history). */
  systemPrompt: string;
  /**
   * Tool-name allowlist. The runner filters the parent's tool set down to
   * these. `delegate` is always stripped (depth cap = 1). Every name MUST
   * exist in the harness's `tools` — validated at load time.
   */
  allowedTools: string[];
  /** Tool-name denylist applied AFTER `allowedTools`. */
  deniedTools?: string[];
  /** Model override (`providerId/modelId`). Defaults to the parent's model. */
  defaultModel?: string;
  /** Step cap forwarded to `stopWhen`. Defaults to 30. */
  maxSteps?: number;
}

/**
 * A subagent slot in a `Harness.subagents` array. Either:
 *
 *   - the slug of a shipped built-in subagent (`"explore"` | `"general"`) —
 *     reused as-is; its `allowedTools` are intersected with the harness's
 *     own tool names (built-ins are generic, so unavailable tools are
 *     silently dropped rather than rejected); OR
 *
 *   - a `SubagentDef` describing a custom subagent — strict Q25 validation
 *     applies (every `allowedTools` entry MUST exist in the harness's tool
 *     set, else `defineHarness` throws).
 */
export type SubagentEntry = BuiltInSubagentSlug | SubagentDef;

export interface Harness {
  /** Stable id; used in run-id, summary, and manifest as the arm label. */
  id: string;
  /** Optional human-readable label. */
  label?: string;
  /** Full system prompt; passed straight to the agent (no section-stripping). */
  systemPrompt: string;
  /** Tool instances available to the agent. Order matters for the prompt. */
  tools: AnyBrowserTool[];
  /**
   * Whether action tools hand back the fresh page state in their result.
   * Default `true` (matches the production extension: action tools return the
   * post-action a11y snapshot). Set `false` for vision-only experiments so
   * the agent only perceives page state when it explicitly calls a perception
   * tool — prevents text-state contamination of a pure-visual arm.
   */
  returnPageStateAfterAction?: boolean;
  /**
   * Field names treated as "auto-returned page state" and stripped from
   * non-perception tool results when `returnPageStateAfterAction` is false.
   * Default `["snapshot", "diff", "refCount"]`.
   */
  pageStateFields?: string[];
  /**
   * Tool names whose output carries page state as IMAGE data. Drives (1) the
   * keep-only-latest-image context trim and (2) multimodal `toModelOutput`
   * routing. Default `["screenshot"]`. Every name MUST exist in `tools`.
   */
  pageStateImageTools?: string[];
  /**
   * Tool names whose call terminates the agent loop after the call/result
   * pair (e.g. a bot-block reporter). Default `[]`. Every name MUST exist
   * in `tools`.
   */
  terminalToolNames?: string[];
  /** Optional default thinking config; CLI `--thinking*` overrides. */
  thinking?: { enabled: boolean; budget?: number };
  /** Optional default model; CLI `--model` overrides. */
  model?: { provider: "anthropic" | "google" | "openai"; id: string };
  /** Optional tool-loop limits. */
  limits?: { contextWindow?: number; maxOutputTokens?: number };
  /** Subagents the parent may delegate to. Enables the `delegate` tool.
   *  Each entry is either a built-in slug (`"explore"`/`"general"`) or a
   *  custom `SubagentDef`. Built-ins are reused as-is with their
   *  `allowedTools` intersected against the harness's tool set; custom
   *  entries are validated strictly (every allowedTool must exist).
   */
  subagents?: SubagentEntry[];
}

/** Default fields stripped when `returnPageStateAfterAction` is false. */
export const DEFAULT_PAGE_STATE_FIELDS = ["snapshot", "diff", "refCount"];
/** Default image-bearing page-state tool. */
export const DEFAULT_PAGE_STATE_IMAGE_TOOLS = ["screenshot"];

const subagentDefSchema = z
  .object({
    slug: z.string().min(1),
    description: z.string(),
    whenToUse: z.string(),
    systemPrompt: z.string().min(1),
    allowedTools: z.array(z.string()),
    deniedTools: z.array(z.string()).optional(),
    defaultModel: z.string().optional(),
    maxSteps: z.number().int().positive().optional(),
  })
  .strict();

const builtInSlugSchema = z.enum(BUILT_IN_SUBAGENT_SLUGS);
const subagentEntrySchema = z.union([builtInSlugSchema, subagentDefSchema]);

// `tools` are BrowserTool instances (functions/objects), not JSON — validate
// them structurally with a passthrough custom check rather than a deep schema.
const browserToolSchema = z.custom<AnyBrowserTool>(
  (v) =>
    !!v &&
    typeof v === "object" &&
    typeof (v as { name?: unknown }).name === "string" &&
    typeof (v as { execute?: unknown }).execute === "function",
  { message: "each tool must be a BrowserTool with a string `name` and `execute` fn" },
);

const harnessSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    systemPrompt: z.string().min(1),
    tools: z.array(browserToolSchema).min(1),
    returnPageStateAfterAction: z.boolean().optional(),
    pageStateFields: z.array(z.string()).optional(),
    pageStateImageTools: z.array(z.string()).optional(),
    terminalToolNames: z.array(z.string()).optional(),
    thinking: z
      .object({ enabled: z.boolean(), budget: z.number().int().positive().optional() })
      .strict()
      .optional(),
    model: z
      .object({
        provider: z.enum(["anthropic", "google", "openai"]),
        id: z.string().min(1),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    subagents: z.array(subagentEntrySchema).optional(),
  })
  .strict();

/**
 * Cross-field validation that Zod's per-field rules can't express: tool-name
 * references must resolve against the harness's own tool set. Errors loudly
 * (per design decision Q25) listing every offending name.
 */
function validateToolReferences(h: Harness): void {
  const toolNames = new Set(h.tools.map((t) => t.name));

  // Duplicate tool names.
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const t of h.tools) {
    if (seen.has(t.name)) dupes.push(t.name);
    seen.add(t.name);
  }
  if (dupes.length > 0) {
    throw new Error(
      `Harness "${h.id}": duplicate tool name(s): ${[...new Set(dupes)].join(", ")}`,
    );
  }

  const checkSubset = (names: string[] | undefined, field: string) => {
    if (!names) return;
    const missing = names.filter((n) => !toolNames.has(n));
    if (missing.length > 0) {
      throw new Error(
        `Harness "${h.id}": ${field} references tool(s) not in the harness tool set: ` +
          `${missing.join(", ")}. Available: ${[...toolNames].join(", ")}.`,
      );
    }
  };

  checkSubset(h.pageStateImageTools, "pageStateImageTools");
  checkSubset(h.terminalToolNames, "terminalToolNames");

  // Subagents: unique slugs + (custom-only) allowedTools strict subset.
  // Built-in slugs are accepted as-is; their `allowedTools` are intersected
  // against `toolNames` at runtime (in build-agent), not validated here.
  if (h.subagents) {
    const slugSeen = new Set<string>();
    const slugDupes: string[] = [];
    const slugOf = (e: SubagentEntry): string =>
      typeof e === "string" ? e : e.slug;
    for (const entry of h.subagents) {
      const slug = slugOf(entry);
      if (slugSeen.has(slug)) slugDupes.push(slug);
      slugSeen.add(slug);
    }
    if (slugDupes.length > 0) {
      throw new Error(
        `Harness "${h.id}": duplicate subagent slug(s): ${[...new Set(slugDupes)].join(", ")}`,
      );
    }
    for (const entry of h.subagents) {
      if (typeof entry === "string") {
        // Built-in: zod already constrained to known slugs; allowedTools are
        // intersected with the harness tool set at construction time. Skip.
        continue;
      }
      const missing = entry.allowedTools.filter(
        (n) => n !== "delegate" && !toolNames.has(n),
      );
      if (missing.length > 0) {
        throw new Error(
          `Harness "${h.id}": subagent "${entry.slug}" allowedTools references tool(s) ` +
            `not in the harness tool set: ${missing.join(", ")}. ` +
            `Available: ${[...toolNames].join(", ")}.`,
        );
      }
    }
  }
}

/**
 * Validate and return a harness definition. Identity at runtime (returns the
 * same object) but enforces the schema + cross-field tool-reference rules so
 * misconfigurations fail loudly at authoring/load time rather than mid-trial.
 */
export function defineHarness(h: Harness): Harness {
  const parsed = harnessSchema.safeParse(h);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid harness "${(h as { id?: string }).id ?? "<unknown>"}":\n${issues}`,
    );
  }
  // Zod strips nothing structurally for BrowserTool (custom passthrough), so
  // the original object is the source of truth; re-run cross-field checks.
  validateToolReferences(h);
  return h;
}

/**
 * Load a harness from a TS/JS module path. Resolves relative to CWD, then
 * dynamic-imports. Accepts a `default` export or a named `harness` export.
 * Re-runs `defineHarness` validation in case the file constructed the object
 * directly without calling it.
 */
export async function loadHarnessFromFile(filePath: string): Promise<Harness> {
  const { resolve, isAbsolute } = await import("node:path");
  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(abs)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to import harness file "${abs}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const candidate = (mod.default ?? mod.harness) as Harness | undefined;
  if (!candidate) {
    throw new Error(
      `Harness file "${abs}" must export a harness as the default export ` +
        `or a named \`harness\` export (use defineHarness({...})).`,
    );
  }

  // Validate (idempotent if the file already called defineHarness).
  return defineHarness(candidate);
}
