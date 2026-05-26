/**
 * Single-task runner. Given a task and a configuration, this:
 *
 *   1. Launches a fresh Playwright Chromium context (one per trial — full
 *      isolation between trials so cookies/storage/fingerprints don't leak).
 *   2. Constructs a `PlaywrightDriver` and a minimal `ToolContext`.
 *   3. Builds a `ToolLoopAgent` with the configured model + prompt + toolset.
 *   4. Drives the agent on the task instruction.
 *   5. Captures token usage, action count, duration.
 *   6. Runs the configured judge.
 *   7. Tears down the browser.
 *
 * The runner returns a typed `TrialResult` regardless of pass/fail/error.
 * Caller decides what to do with it (log, persist, summarize).
 */

import type { LanguageModel } from "ai";
import { resolve } from "node:path";
import type { BrowserDriver, ToolContext, TabId } from "@agent/driver";
import {
  buildTabLegendEntries,
  renderTabLegend,
} from "@agent/tab-legend";
import {
  BENCH_TOOL_CATALOG,
  buildBenchAgent,
  buildBenchSystemPrompt,
  DEFAULT_TOOL_SET,
  type BenchToolName,
} from "./agent/build-agent";
import { PlaywrightDriver } from "./drivers/playwright-driver";
import { KernelDriver } from "./drivers/kernel-driver";
import { VisualizingDriver } from "./drivers/visualizing-driver";
import { judge, type JudgeVerdict } from "./judges";
import { safeSegment } from "./paths";
import { runHeadlessChatLoop } from "./agent/headless-chat";
import type { TodoItem } from "../../../apps/extension/src/lib/types";

import type { BenchmarkTask } from "./tasks/types";
export interface TrialConfig {
  driverKind?: "local" | "kernel";
  model: LanguageModel;
  /** Full provider ID of the model used, e.g. "google:gemini-3-pro-preview" or "gemini-3-pro-preview" */
  modelId?: string;
  /** Display label for the model, included in the trial result for grouping. */
  modelLabel: string;
  systemPromptId?: string;
  systemPrompt?: string;
  toolSetId?: string;
  toolNames?: BenchToolName[];
  /** Override the runner's headless default. Defaults to headed (per spec). */
  headless?: boolean;
  /**
   * Directory to record videos into. When set, the trial saves a single
   * .webm at `<videosDir>/<task-id>.webm`. Pass undefined / omit to skip
   * recording. The runner writes a stable per-task filename (no timestamp
   * suffix) because the run directory itself already provides uniqueness.
   */
  videosDir?: string;
  /**
   * When > 1, the trial will append `-r<n>` to the video filename so
   * replicas of the same task don't clobber each other.
   */
  replicaIndex?: number;
  /**
   * Visualize clicks/typing in the recorded video by injecting overlay DOM
   * via the `VisualizingDriver`. Default: true. The overlays use
   * `pointer-events:none` and very-high z-index so they do not interfere
   * with the agent's actions.
   */
  visualize?: boolean;
  /** Override the default 15min timeout for the trial */
  timeoutMs?: number;
}

export interface TrialResult {
  taskId: string;
  modelLabel: string;
  agentModelId?: string;
  systemPromptId: string;
  toolSetId: string;
  passed: boolean;
  agentAnswer: string;
  finalUrl: string;
  durationMs: number;
  steps: number;
  tokens: {
    in: number;
    out: number;
    total: number;
  };
  judge: JudgeVerdict;
  error?: { kind: string; message: string };
  /** Tool call trace — shape: { name, input, output } per call, in order. */
  trace: TraceEntry[];
  /** Absolute path of the saved trial video, when `videoDir` was provided. */
  videoPath?: string;
  /** Full structure of the conversation parts. */
  parts?: unknown[];
  kernelSessionId?: string | null;
  liveViewUrl?: string | null;
}

export interface TraceEntry {
  name: string;
  input: unknown;
  output: unknown;
}

export async function runTrial(
  task: BenchmarkTask,
  config: TrialConfig,
): Promise<TrialResult> {
  const HARD_TIMEOUT = config.timeoutMs ?? task.timeoutMs ?? 15 * 60_000;
  const HARD_BUFFER = 30_000;

  // We need to keep a reference to the kernel driver if one is created
  // so the hard timeout can clean it up.
  let kernelDriverRef: KernelDriver | undefined;

  const trialPromise = runTrialInner(task, config, (driver) => {
    if (driver instanceof KernelDriver) {
      kernelDriverRef = driver;
    }
  });

  const timeoutPromise = new Promise<TrialResult>((resolve) => {
    setTimeout(() => {
      // If we hard timeout, fire-and-forget delete the kernel session so it doesn't leak
      if (kernelDriverRef && (kernelDriverRef as any).kernelSessionId) {
        try {
          // Access the private kernel property and session ID to force a deletion
          const kernel = (kernelDriverRef as any).kernel;
          const sessionId = (kernelDriverRef as any).kernelSessionId;
          if (kernel && sessionId) {
            kernel.browsers.deleteByID(sessionId).catch(() => {});
          }
        } catch {}
      }

      resolve({
        taskId: task.id,
        modelLabel: config.modelLabel,
        agentModelId: config.modelId,
        systemPromptId: config.systemPromptId ?? "default",
        toolSetId: config.toolSetId ?? `set:${(config.toolNames ?? DEFAULT_TOOL_SET).join("+")}`,
        passed: false,
        agentAnswer: "",
        finalUrl: "",
        durationMs: HARD_TIMEOUT + HARD_BUFFER,
        steps: 0,
        tokens: { in: 0, out: 0, total: 0 },
        judge: { passed: false, reasoning: `Runner error: Trial exceeded hard timeout of ${HARD_TIMEOUT + HARD_BUFFER}ms` },
        error: { kind: "infrastructure-error", message: `Trial exceeded hard timeout of ${HARD_TIMEOUT + HARD_BUFFER}ms` },
        trace: [],
      });
    }, HARD_TIMEOUT + HARD_BUFFER);
  });

  return Promise.race([trialPromise, timeoutPromise]);
}

async function runTrialInner(
  task: BenchmarkTask,
  config: TrialConfig,
  onDriverLaunched: (driver: PlaywrightDriver) => void,
): Promise<TrialResult> {
  const start = Date.now();
  const trace: TraceEntry[] = [];

  let driver: PlaywrightDriver | null = null;
  let driverFacade: BrowserDriver | null = null;
  let agentAnswer = "";
  let finalUrl = "";
  let parts: unknown[] = [];
  let steps = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let error: TrialResult["error"];
  let videoPath: string | undefined;

  // Compute the desired final video path up front (we want this in the
  // result even if the trial errors out before finishing). The `runDir`
  // (caller-managed) already exists; we just compute the file path within
  // its `videos/` subdirectory.
  let plannedVideoPath: string | undefined;
  if (config.videosDir) {
    const safeId = safeSegment(task.id);
    const replicaSuffix =
      config.replicaIndex && config.replicaIndex > 1
        ? `-r${config.replicaIndex}`
        : "";
    plannedVideoPath = resolve(
      config.videosDir,
      `${safeId}${replicaSuffix}.webm`,
    );
  }

  try {
    if (config.driverKind === "kernel") {
      try {
        driver = await KernelDriver.launch({
          headless: config.headless ?? false,
          apiKey: process.env.KERNEL_API_KEY,
          stealth: true,
          recordVideoDir: config.videosDir,
        });
        onDriverLaunched(driver);
      } catch (err) {
        throw { kind: "infrastructure-error", message: `Failed to launch Kernel browser: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      try {
        driver = await PlaywrightDriver.launch({
          headless: config.headless ?? false,
          recordVideoDir: config.videosDir,
        });
        onDriverLaunched(driver);
      } catch (err) {
        throw { kind: "infrastructure-error", message: `Failed to launch Playwright browser: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Wrap the inner driver so click/type CDP commands trigger an overlay
    // injection inside the page. The wrapped driver is what the agent
    // sees; the inner driver is what we hold on to for video lifecycle
    // (saveAs requires the original PlaywrightDriver instance).
    driverFacade =
      config.visualize !== false
        ? new VisualizingDriver(driver, { enabled: true })
        : driver;

    // Bench `ToolSession` is bare-bones: no conversation, no chatDb, no tab
    // handle persistence beyond what the driver itself provides.
    // We add in-memory todo list for the `todoWrite` tool.
    let trialTodos: TodoItem[] = [];

    const ctx: ToolContext = {
      driver: driverFacade,
      session: {
        conversationId: null,
        // Bench TabIds are already stable strings (`t0`, `t1`, ...) emitted
        // by PlaywrightDriver, so we identity-map them as agent-facing
        // handles. No persistence needed — bench trials are single-run.
        getOrCreateHandle: (tabId) => String(tabId),
        resolveHandle: (handle) => handle,
        isAgentOwnedTab: async () => true,
        getTodos: async () => trialTodos,
        setTodos: async (todos) => { trialTodos = todos; },
      },
    };

    // Pre-navigate to the task's startUrl BEFORE building the agent so the
    // initial tab can be included in the system-prompt tab legend. This
    // mirrors how a user would start a session: "I'm on amazon.com, find
    // me a keyboard." `createTab` returns the new tab id but doesn't pin
    // it (mirrors the ExtensionDriver — pinning is the navigate tool's job
    // in production). The runner pins explicitly here so the agent's
    // first tool call has a valid working tab.
    //
    // We use the inner driver here (not the visualizing wrapper) because
    // the initial setup navigation isn't a click/type action — no overlay
    // needed.
    const initialTabId = await driver.createTab(task.startUrl).catch((e) => {
      throw {
        kind: "infrastructure-error",
        message: `Failed to navigate to start URL: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    });
    await driver.setActiveTab(initialTabId);
    await driver.waitForLoad(initialTabId);

    // Build the system prompt with a one-tab legend for the pre-navigated
    // page. Reuses the same builder/renderer as the production extension
    // so bench trials see byte-for-byte the same prompt structure as
    // chrome-side, and any future legend-format change propagates here
    // automatically.
    const baseSystemPrompt = config.systemPrompt ?? buildBenchSystemPrompt();
    const driverForLegend = driver;
    const legendEntries = await buildTabLegendEntries({
      conversationId: "bench",
      ownedTabIds: [initialTabId as number],
      getTab: async (tabId) => {
        // The bench's BENCH_TOOL_CATALOG passes string ids through. Coerce
        // to whatever shape the driver expects; PlaywrightDriver uses
        // strings, ExtensionDriver uses numbers.
        const info = await driverForLegend
          .getTab(tabId as unknown as TabId)
          .catch(() => null);
        return { url: info?.url, title: info?.title };
      },
      getOrCreateHandle: (_cid, tabId) => String(tabId),
      activeTabId: initialTabId,
    });
    const promptWithLegend = `${baseSystemPrompt}\n\n${renderTabLegend(legendEntries)}`;

    const { agent, transport, getNeedsMidStreamCompaction } = buildBenchAgent(ctx, {
      model: config.model,
      systemPrompt: promptWithLegend,
      toolNames: config.toolNames,
      onStepFinish: (step) => {
        steps += 1;
        const u = step.usage;
        if (u.inputTokens != null) tokensIn += u.inputTokens;
        if (u.outputTokens != null) tokensOut += u.outputTokens;
        for (const tc of step.toolCalls ?? []) {
          const matchingResult = step.toolResults?.find(
            (r) => r.toolCallId === tc.toolCallId,
          );
          trace.push({
            name: tc.toolName,
            input: tc.input,
            output: matchingResult?.output ?? null,
          });
        }
      },
    });

    // Set up an abort controller for timeout
    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => abortController.abort(), config.timeoutMs ?? task.timeoutMs ?? 15 * 60_000);

    try {
      const { messages, finalText } = await runHeadlessChatLoop(
        transport,
        config.model,
        { contextWindow: 128000, maxOutputTokens: 8000 },
        task.instruction,
        getNeedsMidStreamCompaction,
        abortController.signal,
        (summaryTokens) => {
          trace.push({
            name: "compaction",
            input: { event: "mid-stream or context overflow" },
            output: { summaryTokens }
          });
        }
      );
      agentAnswer = finalText;
      
      const lastAssoc = messages[messages.length - 1];
      if (lastAssoc && lastAssoc.role === "assistant") {
        // Dedup tool calls by replacing inputs/outputs with pointers to trace
        parts = lastAssoc.parts.map((p: any) => {
          if (p.type === "dynamic-tool") {
            return {
              type: "dynamic-tool",
              toolName: p.toolName,
              toolCallId: p.toolCallId,
              state: p.state
            };
          }
          return p;
        });
      }
    } catch (e: any) {
      if (e.kind === "infrastructure-error") {
        throw e;
      }
      error = {
        kind: "agent-error",
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      clearTimeout(timeoutTimer);
    }

    finalUrl = (await driver.getActiveTab().catch(() => ({ url: "error://unknown" }))).url;
  } catch (err: any) {
    if (err && err.kind) {
      error = err;
    } else {
      error = {
        kind: "runner-error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  } finally {
    if (driver) {
      if (plannedVideoPath) {
        const saved = await Promise.race([
          driver.closeAndSaveVideo(plannedVideoPath),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
        ]);
        if (saved) videoPath = saved;
      } else {
        await Promise.race([
          driver.close(),
          new Promise<void>((resolve) => setTimeout(() => resolve(), 10_000))
        ]).catch(() => {});
      }
    }
  }

  const verdict = error
    ? {
        passed: false,
        reasoning: `Runner error: ${error.message}`,
      }
    : await judge({ task, agentAnswer, finalUrl });

  return {
    taskId: task.id,
    modelLabel: config.modelLabel,
    agentModelId: config.modelId,
    systemPromptId: config.systemPromptId ?? "default",
    toolSetId:
      config.toolSetId ?? `set:${(config.toolNames ?? DEFAULT_TOOL_SET).join("+")}`,
    passed: verdict.passed,
    agentAnswer,
    finalUrl,
    durationMs: Date.now() - start,
    steps,
    tokens: { in: tokensIn, out: tokensOut, total: tokensIn + tokensOut },
    judge: verdict,
    error,
    trace,
    parts,
    videoPath,
    kernelSessionId: driver instanceof KernelDriver ? (driver as any).kernelSessionId : undefined,
    liveViewUrl: driver instanceof KernelDriver ? (driver as any).liveViewUrl : undefined,
  };
}

export { BENCH_TOOL_CATALOG, DEFAULT_TOOL_SET };
export type { BenchToolName };
