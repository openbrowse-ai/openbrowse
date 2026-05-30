/**
 * Manual CLI for the bench harness.
 *
 *   pnpm --filter @openbrowse/bench bench --task <id> [--model <id>]
 *   pnpm --filter @openbrowse/bench bench --task example-com-heading
 *
 * Per the spec's resolved decisions: this is the only entry point in v1.
 * No CI, no cron, no GitHub Action wiring — manual invocation only.
 *
 * This file is a thin shell over `runBench()` (see `./bench.ts`): it loads
 * env, parses argv, resolves the provider model instance + task list, then
 * builds a `BenchConfig` and calls `runBench`. All suite orchestration lives
 * in `bench.ts` so harness authors and integration tests can drive sweeps
 * programmatically without spawning the CLI.
 *
 * IMPORTANT: this file uses dynamic imports for everything that depends on
 * provider env vars. ESM static imports are hoisted above any code in the
 * module, so a top-level `loadEnv()` call followed by `import { anthropic }
 * from "@ai-sdk/anthropic"` would still see an empty `process.env` at the
 * moment the provider's default instance is constructed. Loading env first
 * and then dynamically importing the rest sidesteps that.
 */

import { loadEnv } from "./env";

interface CliArgs {
  taskId?: string;
  /** Run a whole suite by source (e.g. "webbench", "custom"). */
  suite?: "webbench-mini" | "webbench" | "custom" | "all";
  /** Read newline-delimited task IDs from a file. */
  tasksFile?: string;
  modelId: string;
  modelLabel: string;
  /**
   * Path to a harness config file (TS/JS) describing the agent-under-test.
   * When omitted, the trial runs the no-harness default (DEFAULT_TOOL_SET +
   * section-stripped prompt).
   */
  harnessPath?: string;
  /** Enable provider-specific thinking/reasoning (overrides harness default). */
  thinking: boolean;
  /** Thinking token budget (only used when `thinking` is true). */
  thinkingBudget: number;
  /** True when --thinking / --thinking-budget were explicitly passed. */
  thinkingExplicit: boolean;
  /** True when --model was explicitly passed (else harness.model may win). */
  modelExplicit: boolean;
  headless: boolean;
  replicas: number;
  /** Disable video recording (otherwise default-on, written to .bench/runs/<id>/videos/). */
  noVideo: boolean;
  /** Disable click/type overlay visualization in the recorded video. */
  noVisualize: boolean;
  /** Keep the raw .webm originals after MP4 conversion (default: delete). */
  keepWebm: boolean;
  /** Continue a previous run by providing the run directory. */
  resumeDir?: string;
  /** Limit a suite to N randomly-sampled tasks */
  sampleSize?: number;
  /** Deterministic random seed for sampling (default: 42) */
  seed: number;
  /** When resuming, skip trials that previously errored (default: false, meaning retry errors). */
  keepErrors: boolean;
  /** Override the auto-generated run dir (default: .bench/runs/<auto-id>). */
  outDir?: string;
  driverKind: "local" | "kernel";
  concurrency: number;
  /** R2 upload mode. `auto` = upload iff R2 env vars are set; `always` = upload (error if env missing); `never` = skip. */
  upload: "auto" | "always" | "never";
  /** Eval-set name (used in run-id and manifest when upload happens). */
  evalSet?: string;
  /** Arm name within the eval-set. */
  arm?: string;
  /**
   * If set with --driver kernel, the runner acquires browsers from this
   * pre-existing Kernel browser pool (id or name) instead of creating a
   * fresh browser per trial.
   */
  kernelPoolId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    modelId: "claude-sonnet-4-5-20250929",
    modelLabel: "claude-sonnet-4-5",
    thinking: false,
    thinkingBudget: 4096,
    thinkingExplicit: false,
    modelExplicit: false,
    headless: false,
    replicas: 1,
    noVideo: false,
    noVisualize: false,
    keepWebm: false,
    keepErrors: false,
    driverKind: "local",
    concurrency: 0, // 0 means default later
    seed: 42,
    upload: "auto",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        // pnpm sometimes forwards a literal `--` separator. Ignore.
        continue;
      case "--task":
        out.taskId = argv[++i];
        break;
      case "--suite": {
        const v = argv[++i];
        if (v !== "webbench-mini" && v !== "webbench" && v !== "custom" && v !== "all") {
          console.error(`--suite must be one of: webbench-mini, webbench, custom, all`);
          process.exit(2);
        }
        out.suite = v as CliArgs["suite"];
        break;
      }
      case "--tasks-file":
        if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
          console.error("--tasks-file requires a file path argument");
          process.exit(2);
        }
        out.tasksFile = argv[++i];
        break;
      case "--model":
        out.modelId = argv[++i];
        out.modelLabel = out.modelId;
        out.modelExplicit = true;
        break;
      case "--harness":
        if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
          console.error("--harness requires a file path argument");
          process.exit(2);
        }
        out.harnessPath = argv[++i];
        break;
      case "--thinking":
        out.thinking = true;
        out.thinkingExplicit = true;
        break;
      case "--thinking-budget":
        out.thinkingBudget = parseInt(argv[++i], 10);
        out.thinkingExplicit = true;
        if (isNaN(out.thinkingBudget) || out.thinkingBudget <= 0) {
          console.error("--thinking-budget must be a positive integer");
          process.exit(2);
        }
        break;
      case "--kernel-pool":
        out.kernelPoolId = argv[++i];
        break;
      case "--headless":
        out.headless = true;
        break;
      case "--replicas":
        out.replicas = parseInt(argv[++i], 10) || 1;
        break;
      case "--no-video":
        out.noVideo = true;
        break;
      case "--no-visualize":
        out.noVisualize = true;
        break;
      case "--keep-webm":
        out.keepWebm = true;
        break;
      case "--resume":
        out.resumeDir = argv[++i];
        break;
      case "--keep-errors":
        out.keepErrors = true;
        break;
      case "--sample-size":
        out.sampleSize = parseInt(argv[++i], 10);
        if (isNaN(out.sampleSize) || out.sampleSize <= 0) {
          console.error("--sample-size must be a positive integer");
          process.exit(2);
        }
        break;
      case "--seed":
        out.seed = parseInt(argv[++i], 10);
        if (isNaN(out.seed)) {
          console.error("--seed must be an integer");
          process.exit(2);
        }
        break;
      case "--out-dir":
        out.outDir = argv[++i];
        break;
      case "--driver":
        out.driverKind = argv[++i] as "local" | "kernel";
        break;
      case "--concurrency":
        out.concurrency = parseInt(argv[++i], 10) || 0;
        break;
      case "--upload": {
        const v = argv[++i];
        if (v !== "auto" && v !== "always" && v !== "never") {
          console.error(`--upload must be one of: auto, always, never`);
          process.exit(2);
        }
        out.upload = v;
        break;
      }
      case "--no-upload":
        out.upload = "never";
        break;
      case "--eval-set":
        out.evalSet = argv[++i];
        break;
      case "--arm":
        out.arm = argv[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(2);
        }
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`bench - run OpenBrowse evaluation trials

Usage:
  bench --task <task-id> [options]              # single task
  bench --suite <name>  [options]               # run an entire suite
  bench --tasks-file <path> [options]           # run tasks from a list

Options:
  --task <id>         Single task id from any registered suite
  --suite <name>      Run all tasks in a suite. One of: webbench-mini, webbench, custom, all
  --tasks-file <path> File containing one task ID per line. Comments (#)
                      and blank lines are ignored.
  --model <id>        Provider model id (default: claude-sonnet-4-5-20250929)
                      Examples:
                        claude-sonnet-4-5-20250929  (Anthropic)
                        gpt-5                       (OpenAI)
                        gemini-3-flash-preview      (Google)
                        gemini-2.5-flash            (Google)
  --harness <path>    Path to a harness config file (TS/JS) describing the
                      agent-under-test: system prompt, tools, page-state
                      policy, subagents, and optional model/thinking defaults.
                      When omitted, runs the no-harness default (production
                      tool set + section-stripped prompt). Author harness
                      files out-of-tree via defineHarness({...}).
  --thinking          Enable provider-specific thinking/reasoning (overrides
                      the harness default). Captures thought summaries.
  --thinking-budget <N> Thinking token budget (default: 4096). Only used when
                      --thinking is set. Gemini: thinkingBudget. Anthropic:
                      adaptive. OpenAI: maps to medium effort.
  --replicas <n>      Number of times to run each task (default: 1)
  --headless          Run Chromium headless (default: headed)
  --no-video          Disable video recording (default: on)
  --no-visualize      Disable click/type overlays in the recorded video
                      (default: overlays are on when video is on)
  --keep-webm         Keep raw .webm originals after MP4 conversion
                      (default: delete after successful conversion)
  --resume <dir>      Continue a previous run. Skips tasks already completed.
                      Errored trials are re-attempted by default.
  --keep-errors       With --resume, also skip trials that previously errored
                      (default: errored trials are re-attempted)
  --out-dir <dir>     Override run output dir
                      (default: .bench/runs/<auto-id>/ at repo root)
  --driver <kind>     Browser driver to use: "local" (default) or "kernel"
  --kernel-pool <id>  With --driver kernel, acquire browsers from this
                      pre-existing Kernel browser pool (id or name) instead
                      of creating a fresh browser per trial. Eliminates
                      cold-start cost; recommended for high-concurrency runs.
  --concurrency <n>   Parallel trials (default: local=CPUs/2, kernel=5)
  --upload <mode>     R2 upload behavior. One of:
                        auto    upload iff R2_* env vars are set (default)
                        always  upload; error if env vars missing
                        never   skip upload entirely
  --no-upload         Alias for --upload never
  --eval-set <name>   Eval-set name. When set together with --arm, the
                      run-id becomes <ts>-<eval-set>-<arm> and the
                      manifest records both fields. Useful when running
                      the same task list under multiple configurations.
  --arm <name>        Arm name within an eval-set (eg. a, b, c, or
                      descriptive labels like "gpt-5", "claude-4-5")
  --help              Print this help`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function main(): Promise<void> {
  // Load .env BEFORE any provider module is imported. With static ESM
  // imports we couldn't guarantee that — ESM hoists all imports above
  // ordinary statements regardless of source order. So we load env here,
  // then dynamic-import everything that touches the SDKs.
  loadEnv();

  const args = parseArgs(process.argv.slice(2));

  const [
    { anthropic },
    { google },
    { openai },
    { findTask, tasksBySource },
    { sampleTasks },
    { loadTasksFromFile },
    { loadHarnessFromFile },
    { runBench, BenchConfigError },
  ] = await Promise.all([
    import("@ai-sdk/anthropic"),
    import("@ai-sdk/google"),
    import("@ai-sdk/openai"),
    import("./tasks"),
    import("./tasks/sample"),
    import("./tasks/from-file"),
    import("./harness"),
    import("./bench"),
  ]);

  type LanguageModel = Awaited<ReturnType<typeof anthropic>>;

  function resolveModel(modelId: string): LanguageModel {
    if (modelId.startsWith("claude")) return anthropic(modelId);
    if (modelId.startsWith("gpt") || modelId.startsWith("o"))
      return openai(modelId);
    if (modelId.startsWith("gemini")) return google(modelId);
    throw new Error(
      `Cannot infer provider for model id "${modelId}". Use a prefix like 'claude-', 'gpt-', or 'gemini-'.`,
    );
  }

  if (!args.taskId && !args.suite && !args.tasksFile) {
    printHelp();
    console.log(`\nAvailable tasks (custom):`);
    for (const t of await tasksBySource("custom")) {
      console.log(`  ${t.id.padEnd(40)}  ${truncate(t.instruction, 60)}`);
    }
    console.log(`\nAvailable tasks (webbench):`);
    for (const t of await tasksBySource("webbench-mini")) {
      console.log(`  ${t.id.padEnd(40)}  ${truncate(t.instruction, 60)}`);
    }
    process.exit(2);
  }

  const selectionMechanisms = [
    args.taskId ? "--task" : null,
    args.suite ? "--suite" : null,
    args.tasksFile ? "--tasks-file" : null,
  ].filter(Boolean);
  if (selectionMechanisms.length > 1) {
    console.error(
      `These flags are mutually exclusive: ${selectionMechanisms.join(", ")}. Pick exactly one.`,
    );
    process.exit(2);
  }

  if (args.resumeDir && args.outDir) {
    console.error("--resume and --out-dir are mutually exclusive.");
    process.exit(2);
  }

  if (args.taskId && args.sampleSize) {
    console.error("--sample-size cannot be used with --task.");
    process.exit(2);
  }

  // Resolve the task list.
  type Tsk = Awaited<ReturnType<typeof tasksBySource>>[number];
  let resolved: Tsk[];
  if (args.tasksFile) {
    try {
      resolved = await loadTasksFromFile(args.tasksFile, findTask);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  } else if (args.taskId) {
    const task = await findTask(args.taskId);
    if (!task) {
      console.error(`Unknown task id: ${args.taskId}`);
      process.exit(2);
    }
    resolved = [task];
  } else if (args.suite === "all") {
    resolved = await tasksBySource("custom"); // Don't run 1580 tasks on all
  } else {
    resolved = await tasksBySource(args.suite!);
  }

  const preSampleCount = resolved.length;
  if (args.sampleSize) {
    resolved = sampleTasks(resolved, args.sampleSize, args.seed);
  }

  // Load the harness config (if provided).
  const harness = args.harnessPath
    ? await loadHarnessFromFile(args.harnessPath)
    : undefined;

  // Model resolution: explicit --model wins; else harness default; else CLI default.
  const resolvedModelId =
    args.modelExplicit || !harness?.model ? args.modelId : harness.model.id;
  const resolvedModelLabel =
    args.modelExplicit || !harness?.model ? args.modelLabel : harness.model.id;
  const model = resolveModel(resolvedModelId);

  // Thinking resolution: explicit CLI flags win; else harness default.
  const resolvedThinking = args.thinkingExplicit
    ? args.thinking
      ? { enabled: true, budget: args.thinkingBudget }
      : undefined
    : harness?.thinking?.enabled
      ? { enabled: true, budget: harness.thinking.budget ?? args.thinkingBudget }
      : undefined;

  try {
    await runBench({
      tasks: resolved,
      model,
      modelId: resolvedModelId,
      modelLabel: resolvedModelLabel,
      harness,
      thinking: resolvedThinking,
      replicas: args.replicas,
      headless: args.headless,
      noVideo: args.noVideo,
      noVisualize: args.noVisualize,
      keepWebm: args.keepWebm,
      resumeDir: args.resumeDir,
      keepErrors: args.keepErrors,
      outDir: args.outDir,
      driverKind: args.driverKind,
      kernelPoolId: args.kernelPoolId,
      concurrency: args.concurrency,
      upload: args.upload,
      evalSet: args.evalSet,
      arm: args.arm,
      suite: args.suite,
      taskId: args.taskId,
      preSampleCount,
      sampleSize: args.sampleSize,
      seed: args.seed,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    // Config/usage errors get exit code 2 (matching the CLI's other
    // validation paths); genuine runtime failures get exit code 1.
    process.exit(err instanceof BenchConfigError ? 2 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
