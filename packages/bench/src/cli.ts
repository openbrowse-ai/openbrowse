/**
 * Manual CLI for the bench harness.
 *
 *   pnpm --filter @openbrowse/bench bench --task <id> [--model <id>]
 *   pnpm --filter @openbrowse/bench bench --task example-com-heading
 *
 * Per the spec's resolved decisions: this is the only entry point in v1.
 * No CI, no cron, no GitHub Action wiring — manual invocation only.
 *
 * IMPORTANT: this file uses dynamic imports for everything that depends on
 * provider env vars. ESM static imports are hoisted above any code in the
 * module, so a top-level `loadEnv()` call followed by `import { anthropic }
 * from "@ai-sdk/anthropic"` would still see an empty `process.env` at the
 * moment the provider's default instance is constructed. Loading env first
 * and then dynamically importing the rest sidesteps that.
 */

import { loadEnv } from "./env";
import { runInPool } from "./worker-pool";

interface CliArgs {
  taskId?: string;
  /** Run a whole suite by source (e.g. "webbench", "custom"). */
  suite?: "webbench-mini" | "webbench" | "custom" | "all";
  modelId: string;
  modelLabel: string;
  headless: boolean;
  replicas: number;
  /** Disable video recording (otherwise default-on, written to .bench/runs/<id>/videos/). */
  noVideo: boolean;
  /** Disable click/type overlay visualization in the recorded video. */
  noVisualize: boolean;
  /** Keep the raw .webm originals after MP4 conversion (default: delete). */
  keepWebm: boolean;
  /** Override the auto-generated run dir (default: .bench/runs/<auto-id>). */
  outDir?: string;
  driverKind: "local" | "kernel";
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    modelId: "claude-sonnet-4-5-20250929",
    modelLabel: "claude-sonnet-4-5",
    headless: false,
    replicas: 1,
    noVideo: false,
    noVisualize: false,
    keepWebm: false,
    driverKind: "local",
    concurrency: 0, // 0 means default later
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
        out.suite = v as any;
        break;
      }
      case "--model":
        out.modelId = argv[++i];
        out.modelLabel = out.modelId;
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
      case "--out-dir":
        out.outDir = argv[++i];
        break;
      case "--driver":
        out.driverKind = argv[++i] as "local" | "kernel";
        break;
      case "--concurrency":
        out.concurrency = parseInt(argv[++i], 10) || 0;
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

Options:
  --task <id>         Single task id from any registered suite
  --suite <name>      Run all tasks in a suite. One of: webbench-mini, webbench, custom, all
  --model <id>        Provider model id (default: claude-sonnet-4-5-20250929)
                      Examples:
                        claude-sonnet-4-5-20250929  (Anthropic)
                        gpt-5                       (OpenAI)
                        gemini-3-flash-preview      (Google)
                        gemini-2.5-flash            (Google)
  --replicas <n>      Number of times to run each task (default: 1)
  --headless          Run Chromium headless (default: headed)
  --no-video          Disable video recording (default: on)
  --no-visualize      Disable click/type overlays in the recorded video
                      (default: overlays are on when video is on)
  --keep-webm         Keep raw .webm originals after MP4 conversion
                      (default: delete after successful conversion)
  --out-dir <dir>     Override run output dir
                      (default: .bench/runs/<auto-id>/ at repo root)
  --driver <kind>     Browser driver to use: "local" (default) or "kernel"
  --concurrency <n>   Parallel trials (default: local=CPUs/2, kernel=5)
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

  // Dynamic-import after loadEnv so the AI SDK providers see the keys when
  // their default factory instances initialize.
  const [
    { anthropic },
    { google },
    { openai },
    { runTrial },
    { ALL_TASKS, findTask, tasksBySource },
    { createRunPaths, resolveRunDir, makeRunId },
    { writeTrial, writeSummary },
    { ffmpegAvailable, convertAllInDir },
  ] = await Promise.all([
    import("@ai-sdk/anthropic"),
    import("@ai-sdk/google"),
    import("@ai-sdk/openai"),
    import("./runner"),
    import("./tasks"),
    import("./paths"),
    import("./store"),
    import("./video"),
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

  if (!args.taskId && !args.suite) {
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

  // Resolve the task list. Single-task mode picks one; suite mode picks
  // every task whose source matches.
  let tasks: any[];
  if (args.taskId) {
    const task = await findTask(args.taskId);
    if (!task) {
      console.error(`Unknown task id: ${args.taskId}`);
      process.exit(2);
    }
    tasks = [task];
  } else if (args.suite === "all") {
    tasks = await tasksBySource("custom"); // Don't run 1580 tasks on all
  } else {
    tasks = await tasksBySource(args.suite!);
  }

  const model = resolveModel(args.modelId);

  // Set up the run directory. `--out-dir` overrides; otherwise auto-generate
  // a timestamped subdir under `.bench/runs/`.
  const runId = makeRunId({
    modelLabel: args.modelLabel,
    suite: args.suite,
    taskId: args.taskId,
  });
  const runDir = resolveRunDir({
    runId,
    outDirOverride: args.outDir,
  });
  const paths = createRunPaths(runDir);

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const recordVideo = !args.noVideo;
  const visualize = !args.noVisualize;

  // Determine concurrency
  let concurrency = args.concurrency;
  if (concurrency === 0) {
    if (args.driverKind === "kernel") {
      concurrency = 5; // Default free tier
    } else {
      const os = await import("node:os");
      concurrency = Math.max(1, Math.floor(os.cpus().length / 2));
    }
  }

  console.log(
    `Running ${tasks.length} task(s) × ${args.replicas} replicas, model=${args.modelLabel}, concurrency=${concurrency}`,
  );
  console.log(`Run dir:   ${paths.runDir}`);
  console.log(`Video:     ${recordVideo ? "enabled" : "disabled"}`);
  console.log(`Visualize: ${recordVideo && visualize ? "enabled" : "disabled"}`);
  console.log("");

  type Row = {
    taskId: string;
    passed: number;
    total: number;
    infrastructureFailures: number;
    agentFailures: number;
    judgeRejects: number;
    avgSteps: number;
    avgTokensIn: number;
    avgTokensOut: number;
    avgDurationMs: number;
    domain: string;
    videoPaths: string[];
    trialPaths: string[];
  };
  const rows: Row[] = [];
  const allTrialPaths: string[] = [];

  let completedTasks = 0;
  const totalTasks = tasks.length;
  let runningTasks = 0;

  await runInPool(tasks, concurrency, async (task, index) => {
    runningTasks++;
    
    let passes = 0;
    let infraFails = 0;
    let agentFails = 0;
    let judgeRejects = 0;
    let stepsSum = 0;
    let inSum = 0;
    let outSum = 0;
    let timeSum = 0;
    let domain = "";
    try {
      domain = new URL(task.startUrl).hostname.replace(/^www\./, "");
    } catch {}
    const videos: string[] = [];
    const trials: string[] = [];

    // Buffer output so parallel runs don't interleave console lines
    const logBuffer: string[] = [];
    logBuffer.push(`=== ${task.id} ===`);
    logBuffer.push(`  ${truncate(task.instruction, 100)}`);

    for (let i = 1; i <= args.replicas; i++) {
      const tag = args.replicas > 1 ? ` [${i}/${args.replicas}]` : "";
      const result = await runTrial(task, {
        model,
        modelLabel: args.modelLabel,
        headless: args.headless,
        videosDir: recordVideo ? paths.videosDir : undefined,
        replicaIndex: args.replicas > 1 ? i : undefined,
        visualize,
        driverKind: args.driverKind,
      });

      // Persist each trial immediately so a sweep that crashes mid-way still
      // leaves the completed trials on disk.
      const trialPath = writeTrial(paths, result);
      trials.push(trialPath);
      allTrialPaths.push(trialPath);

      logBuffer.push(
        `  Trial${tag}: ${result.passed ? "PASS" : "FAIL"} steps=${result.steps} tokens=${result.tokens.in}/${result.tokens.out} time=${(result.durationMs / 1000).toFixed(1)}s`,
      );
      if (result.error) logBuffer.push(`    error: ${result.error.message}`);
      logBuffer.push(`    answer: ${truncate(result.agentAnswer, 160)}`);
      logBuffer.push(`    judge:  ${truncate(result.judge.reasoning, 160)}`);
      if (result.videoPath) {
        logBuffer.push(`    video:  ${result.videoPath}`);
        videos.push(result.videoPath);
      }
      if (result.liveViewUrl) {
        logBuffer.push(`    live:   ${result.liveViewUrl}`);
      }

      if (result.passed) {
        passes++;
      } else if (result.error) {
        if (result.error.kind === "infrastructure-error") infraFails++;
        else agentFails++;
      } else {
        judgeRejects++;
      }

      stepsSum += result.steps;
      inSum += result.tokens.in;
      outSum += result.tokens.out;
      timeSum += result.durationMs;
    }

    const total = args.replicas;
    rows.push({
      taskId: task.id,
      passed: passes,
      total,
      infrastructureFailures: infraFails,
      agentFailures: agentFails,
      judgeRejects: judgeRejects,
      avgSteps: stepsSum / total,
      avgTokensIn: inSum / total,
      avgTokensOut: outSum / total,
      avgDurationMs: timeSum / total,
      domain,
      videoPaths: videos,
      trialPaths: trials,
    });
    
    runningTasks--;
    completedTasks++;
    
    // Print everything for this task in one block
    console.log(logBuffer.join("\n"));
    console.log(`[${completedTasks}/${totalTasks} done | ${runningTasks} in flight]`);
    console.log("");
  });

  // Summary table
  console.log("Summary");
  console.log("-------");
  let overallPassed = 0;
  let overallTotal = 0;
  let overallInfraFails = 0;
  let overallAgentFails = 0;
  let overallJudgeRejects = 0;
  let overallTokensIn = 0;
  let overallTokensOut = 0;
  let overallDurationMs = 0;
  
  const failuresByDomain: Record<string, number> = {};

  for (const r of rows) {
    overallPassed += r.passed;
    overallTotal += r.total;
    overallInfraFails += r.infrastructureFailures;
    overallAgentFails += r.agentFailures;
    overallJudgeRejects += r.judgeRejects;
    overallTokensIn += r.avgTokensIn * r.total;
    overallTokensOut += r.avgTokensOut * r.total;
    overallDurationMs += r.avgDurationMs * r.total;
    
    if (r.total > r.passed) {
      failuresByDomain[r.domain] = (failuresByDomain[r.domain] || 0) + (r.total - r.passed);
    }
    
    console.log(
      `  ${r.taskId.padEnd(35)} ${r.passed}/${r.total}   steps=${r.avgSteps.toFixed(1).padStart(5)}   in=${Math.round(r.avgTokensIn).toString().padStart(6)}   out=${Math.round(r.avgTokensOut).toString().padStart(4)}   time=${(r.avgDurationMs / 1000).toFixed(1)}s`,
    );
  }
  console.log("");
  console.log(
    `Pass rate: ${overallPassed}/${overallTotal} (${((overallPassed / overallTotal) * 100).toFixed(0)}%)`,
  );
  if (overallTotal > 0) {
    console.log(`Breakdown:`);
    console.log(`  Agent Errors:  ${((overallAgentFails / overallTotal) * 100).toFixed(1)}%`);
    console.log(`  Infra Errors:  ${((overallInfraFails / overallTotal) * 100).toFixed(1)}%`);
    console.log(`  Judge Rejects: ${((overallJudgeRejects / overallTotal) * 100).toFixed(1)}%`);
  }
  console.log(
    `Total tokens: in=${overallTokensIn.toLocaleString()}  out=${overallTokensOut.toLocaleString()}`,
  );
  console.log(
    `Total wall time: ${(overallDurationMs / 1000 / 60).toFixed(1)} min`,
  );

  // Convert recorded videos to mp4. Done as a post-sweep batch (rather
  // than per-trial) so trial timing reflects only agent + browser, not
  // ffmpeg. Conversions run in parallel up to a fixed cap.
  if (recordVideo) {
    const ffOk = await ffmpegAvailable();
    if (!ffOk) {
      console.log("");
      console.log(
        "WARNING: ffmpeg not on PATH. Skipping mp4 conversion.\n" +
          "  Install with: brew install ffmpeg   (macOS)\n" +
          "                apt install ffmpeg    (Debian/Ubuntu)\n" +
          `  Raw .webm videos still saved at: ${paths.videosDir}`,
      );
    } else {
      console.log("");
      console.log(`Converting videos to mp4...`);
      const ffStart = Date.now();
      const convResults = await convertAllInDir(paths.videosDir, {
        deleteSource: !args.keepWebm,
        concurrency: 4,
      });
      const okCount = convResults.filter((r) => r.ok).length;
      const failCount = convResults.length - okCount;
      console.log(
        `  ${okCount}/${convResults.length} converted in ${((Date.now() - ffStart) / 1000).toFixed(1)}s`,
      );
      if (failCount > 0) {
        for (const r of convResults.filter((r) => !r.ok)) {
          console.log(`  FAILED: ${r.source}`);
          if (r.stderr) console.log(`    ${r.stderr.trim().split("\n").pop()}`);
        }
      }
    }
  }

  // Write the aggregate summary alongside the per-trial JSONs.
  const summaryPath = writeSummary(paths, {
    runId,
    model: args.modelLabel,
    suite: args.suite,
    taskId: args.taskId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    tasks: tasks.length,
    replicas: args.replicas,
    passed: overallPassed,
    passRate: overallPassed / overallTotal,
    breakdown: {
      agentAccuracy: overallPassed / overallTotal,
      infrastructureFailureRate: overallInfraFails / overallTotal,
      judgeRejectRate: overallJudgeRejects / overallTotal,
    },
    failuresByDomain,
    tokens: {
      in: overallTokensIn,
      out: overallTokensOut,
      total: overallTokensIn + overallTokensOut,
    },
    trialPaths: allTrialPaths,
  });
  console.log("");
  console.log(`Summary: ${summaryPath}`);
  console.log(`Trials:  ${paths.trialsDir}`);
  if (recordVideo) {
    console.log(`Videos:  ${paths.videosDir}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
