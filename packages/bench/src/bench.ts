/**
 * Programmatic suite orchestration.
 *
 * `runBench(config)` is the public, in-process API for running a sweep —
 * the same orchestration `cli.ts:main()` performs (task list resolution,
 * pooled per-trial execution with resume, video conversion, summary write,
 * and optional R2 upload), exposed as a single function so harness authors
 * and integration tests can drive sweeps without spawning the CLI.
 *
 * The CLI is a thin shell over this: it loads env, parses argv, resolves the
 * provider model instance, then constructs `BenchConfig` and calls `runBench`.
 *
 * Inputs are deliberately fully-resolved (the model is a `LanguageModel`
 * instance, not an id string; tasks are `BenchmarkTask` objects, not ids):
 * provider/env loading and task lookup belong to the caller. This keeps
 * `runBench` free of dynamic imports, env coupling, and ESM hoist hazards.
 */

import type { LanguageModel } from "ai";
import {
  BENCH_TOOL_CATALOG,
  buildBenchSystemPrompt,
  DEFAULT_TOOL_SET,
} from "./agent/build-agent";
import type { Harness } from "./harness";
import {
  ensureRunDirExists,
  createRunPaths,
  makeRunId,
  resolveRunDir,
  type RunPaths,
} from "./paths";
import { runTrial, type TrialResult } from "./runner";
import { readAllTrials, writeSummary, writeTrial, type RunSummary } from "./store";
import type { BenchmarkTask } from "./tasks/types";
import { convertAllInDir, ffmpegAvailable } from "./video";
import { runInPool } from "./worker-pool";

/**
 * Thrown for invalid `BenchConfig` combinations (mutually-exclusive flags,
 * upload requested without credentials/eval-set/arm). The CLI maps this to
 * exit code 2 ("usage / misconfiguration"), distinct from exit code 1 used
 * for genuine runtime failures (e.g. a failed upload mid-run). Preserves the
 * exit-code contract the original cli.ts exposed before `runBench` was
 * extracted.
 */
export class BenchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchConfigError";
  }
}

export interface BenchConfig {
  /** Tasks to run. Already resolved (caller does the lookup). */
  tasks: BenchmarkTask[];
  /** Resolved language-model instance. */
  model: LanguageModel;
  /** Provider model id (e.g. "claude-sonnet-4-5-20250929"). */
  modelId: string;
  /** Display label for grouping (defaults to modelId when omitted). */
  modelLabel?: string;
  /** Harness config (when omitted, no-harness defaults are used). */
  harness?: Harness;
  /** Resolved thinking config (CLI/harness merge already done by caller). */
  thinking?: { enabled: boolean; budget?: number };
  /** Replicas per task. Defaults to 1. */
  replicas?: number;
  /** Headless Chromium. Defaults to false (headed). */
  headless?: boolean;
  /** Disable video recording. Defaults to false (videos on). */
  noVideo?: boolean;
  /** Disable click/type overlays in recorded video. Defaults to false. */
  noVisualize?: boolean;
  /** Keep raw .webm originals after MP4 conversion. Defaults to false. */
  keepWebm?: boolean;
  /** Resume an existing run by directory. Mutually exclusive with `outDir`. */
  resumeDir?: string;
  /** With `resumeDir`, skip previously-errored trials (default: re-attempt). */
  keepErrors?: boolean;
  /** Override the auto-generated run dir. */
  outDir?: string;
  /** Browser driver. Defaults to "local". */
  driverKind?: "local" | "kernel";
  /** Pre-existing Kernel browser pool id/name (with `driverKind: "kernel"`). */
  kernelPoolId?: string;
  /** Trial concurrency. 0 → defaults (local: CPU/2, kernel: 5). */
  concurrency?: number;
  /** R2 upload mode. Defaults to "auto" (env-driven). */
  upload?: "auto" | "always" | "never";
  /** Eval-set name; required when uploading. */
  evalSet?: string;
  /** Arm label within an eval-set; required when uploading. */
  arm?: string;
  /** Suite tag for run-id construction (purely cosmetic). */
  suite?: "webbench-mini" | "webbench" | "custom" | "all";
  /** Single-task tag for run-id construction (set when running one task). */
  taskId?: string;
  /** Pre-sample task count (suite size before sampling). */
  preSampleCount?: number;
  /** Sample size used (when sampling was applied). */
  sampleSize?: number;
  /** Sampling seed (when sampling was applied). */
  seed?: number;
}

export interface BenchSummary {
  /** Generated or resumed run id. */
  runId: string;
  /** Absolute run-dir path. */
  runDir: string;
  /** Absolute summary.json path. */
  summaryPath: string;
  /** Absolute trials/ dir. */
  trialsDir: string;
  /** Absolute videos/ dir (whether or not videos were recorded). */
  videosDir: string;
  /** Absolute manifest.json path when uploaded; else undefined. */
  manifestPath?: string;
  /** Roll-up numbers (mirrors what the CLI prints). */
  totals: {
    tasks: number;
    replicas: number;
    passed: number;
    total: number;
    passRate: number;
    infrastructureFailures: number;
    agentFailures: number;
    botBlocked: number;
    judgeRejects: number;
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
  };
  failuresByDomain: Record<string, number>;
  /** True iff R2 upload succeeded. */
  uploaded: boolean;
}

interface AggregateRow {
  taskId: string;
  passed: number;
  total: number;
  infrastructureFailures: number;
  agentFailures: number;
  botBlocked: number;
  judgeRejects: number;
  avgSteps: number;
  avgTokensIn: number;
  avgTokensOut: number;
  avgDurationMs: number;
  domain: string;
  videoPaths: string[];
  trialPaths: string[];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * Run a complete bench sweep. See `BenchConfig` for inputs and `BenchSummary`
 * for outputs. Identical behavior to the CLI: writes per-trial JSONs, a
 * summary, optional videos, and uploads to R2 when configured.
 *
 * Throws synchronously on misconfigurations (mutually-exclusive flags,
 * upload-without-eval-set, missing R2 env when `upload: "always"`).
 */
export async function runBench(config: BenchConfig): Promise<BenchSummary> {
  const {
    tasks: initialTasks,
    model,
    modelId,
    modelLabel = modelId,
    harness,
    thinking,
    replicas = 1,
    headless = false,
    noVideo = false,
    noVisualize = false,
    keepWebm = false,
    resumeDir,
    keepErrors = false,
    outDir,
    driverKind = "local",
    kernelPoolId,
    upload = "auto",
    evalSet,
    arm,
    suite,
    taskId,
    preSampleCount,
    sampleSize,
    seed,
  } = config;

  if (resumeDir && outDir) {
    throw new BenchConfigError("`resumeDir` and `outDir` are mutually exclusive.");
  }

  // Fail fast on upload misconfigurations before running any trials.
  const { uploadRun, createR2Client, r2EnvPresent } = await import("./upload");
  let plannedUpload = false;
  switch (upload) {
    case "never":
      plannedUpload = false;
      break;
    case "always":
      plannedUpload = true;
      if (!r2EnvPresent()) {
        throw new BenchConfigError(
          "upload: 'always' was set but required R2 env vars are not present " +
            "(R2_ACCOUNT_ID, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).",
        );
      }
      break;
    case "auto":
      plannedUpload = r2EnvPresent();
      break;
  }
  if (plannedUpload && (!evalSet || !arm)) {
    throw new BenchConfigError(
      "Upload requires both `evalSet` and `arm` to make artifacts traceable. " +
        "Pass both, or set upload: 'never'.",
    );
  }

  // Arm id (run grouping) and tool-set metadata.
  const armId = harness?.id ?? "default";
  const armToolNames = harness ? harness.tools.map((t) => t.name) : DEFAULT_TOOL_SET;

  // Run-dir resolution (resume reuses the existing dir).
  let runId: string;
  let runDir: string;
  let paths: RunPaths;
  let existingTrials: TrialResult[] = [];

  if (resumeDir) {
    paths = ensureRunDirExists(resumeDir);
    runDir = paths.runDir;
    const path = await import("node:path");
    runId = path.basename(runDir);
    existingTrials = readAllTrials(paths);
  } else {
    runId = makeRunId({
      modelLabel,
      suite,
      taskId,
      evalSet,
      arm,
    });
    runDir = resolveRunDir({ runId, outDirOverride: outDir });
    paths = createRunPaths(runDir);
  }

  const startedAt = new Date().toISOString();

  // Resume bookkeeping: skip already-completed task ids; optionally retry errors.
  const completedTaskIds = new Set<string>();
  const erroredTaskIds = new Set<string>();
  let tasks = initialTasks;
  if (resumeDir) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const t of existingTrials) {
      if (!keepErrors && t.error) {
        erroredTaskIds.add(t.taskId);
        try {
          fs.unlinkSync(path.join(paths.trialsDir, `${t.taskId}.json`));
        } catch {}
      } else {
        completedTaskIds.add(t.taskId);
      }
    }
    const initialCount = tasks.length;
    tasks = tasks.filter((t) => !completedTaskIds.has(t.id));
    try {
      const logMsg = `[${startedAt}] Resumed sweep. Original tasks: ${initialCount}, Already completed: ${completedTaskIds.size}, Retrying errors: ${erroredTaskIds.size}, Running now: ${tasks.length}\n`;
      fs.appendFileSync(path.join(paths.runDir, "resume.log"), logMsg);
    } catch {}
  }

  const startMs = Date.now();
  const recordVideo = !noVideo;
  const visualize = !noVisualize;

  // Default concurrency.
  let concurrency = config.concurrency ?? 0;
  if (concurrency === 0) {
    if (driverKind === "kernel") {
      concurrency = 5;
    } else {
      const os = await import("node:os");
      concurrency = Math.max(1, Math.floor(os.cpus().length / 2));
    }
  }

  console.log(
    `Running ${tasks.length} task(s) × ${replicas} replicas, model=${modelLabel}, concurrency=${concurrency}`,
  );
  if (resumeDir) {
    console.log(
      `Resuming from ${paths.runDir}: ${completedTaskIds.size} already done, ${tasks.length} remaining (${erroredTaskIds.size} errored, will retry)`,
    );
  } else {
    console.log(`Run dir:   ${paths.runDir}`);
  }
  console.log(`Video:     ${recordVideo ? "enabled" : "disabled"}`);
  console.log(`Visualize: ${recordVideo && visualize ? "enabled" : "disabled"}`);
  console.log("");

  let completedTasks = 0;
  const totalTasks = tasks.length;
  let runningTasks = 0;

  if (tasks.length > 0) {
    await runInPool(tasks, concurrency, async (task) => {
      runningTasks++;

      const trials: string[] = [];
      const videos: string[] = [];

      const logBuffer: string[] = [];
      logBuffer.push(`=== ${task.id} ===`);
      logBuffer.push(`  ${truncate(task.instruction, 100)}`);

      for (let i = 1; i <= replicas; i++) {
        const tag = replicas > 1 ? ` [${i}/${replicas}]` : "";
        const result = await runTrial(task, {
          model,
          modelId,
          modelLabel,
          armId,
          harness,
          systemPromptId: armId,
          toolSetId: `set:${armToolNames.join("+")}`,
          thinking,
          headless,
          videosDir: recordVideo ? paths.videosDir : undefined,
          replicaIndex: replicas > 1 ? i : undefined,
          visualize,
          driverKind,
          kernelPoolId,
        });

        const trialPath = writeTrial(paths, result);
        trials.push(trialPath);

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
      }

      runningTasks--;
      completedTasks++;
      console.log(logBuffer.join("\n"));
      console.log(`[${completedTasks}/${totalTasks} done | ${runningTasks} in flight]`);
      console.log("");
    });
  }

  // Reload all trials from disk to assemble the final summary (so resumed
  // runs include previously-completed trials).
  const finalTrials = readAllTrials(paths);
  const finalRows: AggregateRow[] = [];
  const trialsByTask = new Map<string, TrialResult[]>();
  for (const t of finalTrials) {
    if (!trialsByTask.has(t.taskId)) trialsByTask.set(t.taskId, []);
    trialsByTask.get(t.taskId)!.push(t);
  }

  const path = await import("node:path");
  for (const [taskIdInner, trialList] of trialsByTask.entries()) {
    let passes = 0,
      infraFails = 0,
      agentFails = 0,
      botBlocks = 0,
      judgeRejects = 0;
    let stepsSum = 0,
      inSum = 0,
      outSum = 0,
      timeSum = 0;
    const vPaths: string[] = [];
    const tPaths: string[] = [];
    let domain = "";
    for (const res of trialList) {
      if (res.passed) passes++;
      else if (res.error) {
        if (res.error.kind === "infrastructure-error") infraFails++;
        else if (res.error.kind === "bot-blocked") botBlocks++;
        else agentFails++;
      } else {
        judgeRejects++;
      }
      stepsSum += res.steps;
      inSum += res.tokens.in;
      outSum += res.tokens.out;
      timeSum += res.durationMs;
      if (res.videoPath) vPaths.push(res.videoPath);
      tPaths.push(path.join(paths.trialsDir, `${res.taskId}.json`));
      if (!domain && res.finalUrl) {
        try {
          domain = new URL(res.finalUrl).hostname.replace(/^www\./, "");
        } catch {}
      }
    }
    const count = trialList.length;
    finalRows.push({
      taskId: taskIdInner,
      passed: passes,
      total: count,
      infrastructureFailures: infraFails,
      agentFailures: agentFails,
      botBlocked: botBlocks,
      judgeRejects,
      avgSteps: stepsSum / count,
      avgTokensIn: inSum / count,
      avgTokensOut: outSum / count,
      avgDurationMs: timeSum / count,
      domain,
      videoPaths: vPaths,
      trialPaths: tPaths,
    });
  }

  console.log("Summary");
  console.log("-------");
  let overallPassed = 0,
    overallTotal = 0,
    overallInfraFails = 0,
    overallAgentFails = 0,
    overallBotBlocks = 0,
    overallJudgeRejects = 0,
    overallTokensIn = 0,
    overallTokensOut = 0,
    overallDurationMs = 0;
  const failuresByDomain: Record<string, number> = {};
  for (const r of finalRows) {
    overallPassed += r.passed;
    overallTotal += r.total;
    overallInfraFails += r.infrastructureFailures;
    overallAgentFails += r.agentFailures;
    overallBotBlocks += r.botBlocked;
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
    `Pass rate: ${overallPassed}/${overallTotal} (${overallTotal === 0 ? "0" : ((overallPassed / overallTotal) * 100).toFixed(0)}%)`,
  );
  if (overallTotal > 0) {
    console.log(`Breakdown:`);
    console.log(`  Agent Errors:  ${((overallAgentFails / overallTotal) * 100).toFixed(1)}%`);
    console.log(`  Infra Errors:  ${((overallInfraFails / overallTotal) * 100).toFixed(1)}%`);
    console.log(`  Bot-blocked:   ${((overallBotBlocks / overallTotal) * 100).toFixed(1)}%`);
    console.log(`  Judge Rejects: ${((overallJudgeRejects / overallTotal) * 100).toFixed(1)}%`);
  }
  console.log(
    `Total tokens: in=${overallTokensIn.toLocaleString()}  out=${overallTokensOut.toLocaleString()}`,
  );
  console.log(`Total wall time: ${(overallDurationMs / 1000 / 60).toFixed(1)} min`);

  // Convert recorded videos to mp4 (post-sweep batch).
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
        deleteSource: !keepWebm,
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

  // Build the harness-metadata block written into summary.json.
  const trialPaths = finalTrials.map((t) => path.join(paths.trialsDir, `${t.taskId}.json`));
  const crypto = await import("node:crypto");
  const child_process = await import("node:child_process");
  const { z } = await import("zod");

  const systemPromptText = harness ? harness.systemPrompt : buildBenchSystemPrompt();
  const systemPromptHash = crypto
    .createHash("sha256")
    .update(systemPromptText)
    .digest("hex")
    .slice(0, 16);

  let gitSha: string | undefined;
  try {
    gitSha = child_process
      .execSync("git rev-parse HEAD", { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {}

  let benchVersion = "0.0.0";
  try {
    const pkg = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        path.join(process.cwd(), "package.json"),
        "utf8",
      ),
    );
    benchVersion = pkg.version || "0.0.0";
  } catch {}

  const toolInstancesForMeta = harness
    ? harness.tools
    : DEFAULT_TOOL_SET.map((name) => BENCH_TOOL_CATALOG[name]);

  const { LLM_JUDGE_VERSION, JUDGE_MODEL_ID } = await import("./judges/llm-judge");
  const { WEBBENCH_REVISION } = await import("./tasks/webbench/revision");

  const harnessMeta: NonNullable<RunSummary["harness"]> = {
    agent: {
      modelId,
      systemPromptId: armId,
      systemPromptHash,
      systemPromptText,
      toolSet: toolInstancesForMeta.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.parameters),
        outputSchema: t.outputSchema ? z.toJSONSchema(t.outputSchema) : undefined,
      })),
      limits: {
        contextWindow: harness?.limits?.contextWindow ?? 128000,
        maxOutputTokens: harness?.limits?.maxOutputTokens ?? 8000,
      },
      thinking: thinking
        ? { enabled: true, budget: thinking.budget }
        : { enabled: false },
    },
    driver: {
      kind: driverKind,
      headless,
      stealth: true,
      visualize,
      viewport: { width: 1280, height: 800 },
    },
    run: {
      concurrency,
      replicas,
      timeoutMs: 15 * 60000,
      hardTimeoutBufferMs: 30000,
    },
    judge: { modelId: JUDGE_MODEL_ID, version: LLM_JUDGE_VERSION },
    suite: {
      source: suite,
      revision: WEBBENCH_REVISION,
      totalTasks: preSampleCount,
      sampleSize,
      seed,
    },
    provenance: {
      benchVersion,
      gitSha,
      nodeVersion: process.version,
      platform: process.platform,
    },
  };

  const summaryPath = writeSummary(paths, {
    runId,
    model: modelLabel,
    suite,
    taskId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    tasks: finalRows.length,
    replicas,
    passed: overallPassed,
    passRate: overallTotal === 0 ? 0 : overallPassed / overallTotal,
    breakdown: {
      agentAccuracy: overallTotal === 0 ? 0 : overallPassed / overallTotal,
      infrastructureFailureRate: overallTotal === 0 ? 0 : overallInfraFails / overallTotal,
      botBlockedRate: overallTotal === 0 ? 0 : overallBotBlocks / overallTotal,
      judgeRejectRate: overallTotal === 0 ? 0 : overallJudgeRejects / overallTotal,
    },
    failuresByDomain,
    tokens: {
      in: overallTokensIn,
      out: overallTokensOut,
      total: overallTokensIn + overallTokensOut,
    },
    harness: harnessMeta,
    trialPaths,
  });
  console.log("");
  console.log(`Summary: ${summaryPath}`);
  console.log(`Trials:  ${paths.trialsDir}`);
  if (recordVideo) {
    console.log(`Videos:  ${paths.videosDir}`);
  }

  // Re-evaluate `auto` upload against current env (it may have flipped).
  const shouldUpload =
    upload === "never" ? false : upload === "always" ? true : r2EnvPresent();
  let manifestPath: string | undefined;
  let uploaded = false;
  if (shouldUpload) {
    if (!evalSet || !arm) {
      throw new BenchConfigError(
        "Upload requires both `evalSet` and `arm`. Either provide both, or set upload: 'never'.",
      );
    }
    console.log("");
    console.log(`Uploading to R2 (bucket=${process.env.R2_BUCKET})...`);
    const uploadStart = Date.now();
    try {
      const { client, bucket } = createR2Client();
      const manifest = await uploadRun({
        paths,
        runId,
        evalSet,
        arm,
        deps: { s3Client: client, bucket },
      });
      const uploadDuration = ((Date.now() - uploadStart) / 1000).toFixed(1);
      console.log(
        `  ${Object.keys(manifest.trials).length} trial(s) uploaded in ${uploadDuration}s`,
      );
      console.log(`  Manifest: ${paths.manifestPath}`);
      manifestPath = paths.manifestPath;
      uploaded = true;
    } catch (err) {
      console.error("Upload failed:", err instanceof Error ? err.message : String(err));
      console.error("Local artifacts preserved in:", paths.runDir);
      throw err;
    }
  }

  return {
    runId,
    runDir: paths.runDir,
    summaryPath,
    trialsDir: paths.trialsDir,
    videosDir: paths.videosDir,
    manifestPath,
    totals: {
      tasks: finalRows.length,
      replicas,
      passed: overallPassed,
      total: overallTotal,
      passRate: overallTotal === 0 ? 0 : overallPassed / overallTotal,
      infrastructureFailures: overallInfraFails,
      agentFailures: overallAgentFails,
      botBlocked: overallBotBlocks,
      judgeRejects: overallJudgeRejects,
      tokensIn: overallTokensIn,
      tokensOut: overallTokensOut,
      durationMs: overallDurationMs,
    },
    failuresByDomain,
    uploaded,
  };
}
