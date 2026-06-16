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
import type { BrowserDriver, ToolContext } from "@agent/driver";
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
import type { Harness } from "./harness";
import type { AgentDefinition } from "@agent/subagents/types";
import { PlaywrightDriver } from "./drivers/playwright-driver";
import { KernelDriver } from "./drivers/kernel-driver";
import { VisualizingDriver } from "./drivers/visualizing-driver";
import { judge, type JudgeVerdict } from "./judges";
import { safeSegment } from "./paths";
import { runHeadlessChatLoop } from "./agent/headless-chat";
import { redactImageData } from "./agent/trace-redact";
import type { TodoItem } from "../../../apps/extension/src/lib/types";

import type { BenchmarkTask } from "./tasks/types";
export interface TrialConfig {
  driverKind?: "local" | "kernel";
  /**
   * If set with `driverKind: "kernel"`, the trial acquires its browser from
   * this pre-existing Kernel browser pool (by id or name) instead of
   * creating a fresh browser. Eliminates cold-start cost so high-concurrency
   * runs don't trip Kernel's burst-creation rate limit.
   */
  kernelPoolId?: string;
  /** Bench arm / harness id, used for trial-result grouping and labelling. */
  armId?: string;
  /**
   * Declarative harness describing the agent-under-test (prompt, tools,
   * page-state policy, subagents, optional model/thinking/limit defaults).
   * When omitted, the trial runs the no-harness default (DEFAULT_TOOL_SET +
   * section-stripped prompt).
   */
  harness?: Harness;
  model: LanguageModel;
  /** Full provider ID of the model used, e.g. "google:gemini-3-pro-preview" or "gemini-3-pro-preview" */
  modelId?: string;
  /** Display label for the model, included in the trial result for grouping. */
  modelLabel: string;
  systemPromptId?: string;
  systemPrompt?: string;
  toolSetId?: string;
  toolNames?: BenchToolName[];
  /** Enable provider-specific thinking/reasoning. Captures thought summaries in trace + parts. */
  thinking?: { enabled: boolean; budget?: number };
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
  /**
   * For `delegate` tool calls: the nested subagent's own trace + final text +
   * token usage. Populated by the runner from the delegate tool's raw output.
   */
  subagent?: {
    slug: string;
    finalText: string;
    status: string;
    trace: TraceEntry[];
    tokens: { in: number; out: number };
  };
}

/**
 * Mutable progress object shared between `runTrial` and `runTrialInner`.
 *
 * The hard-timeout watchdog in `runTrial` reads this when it fires so the
 * trial result reflects what the agent actually accomplished before being
 * killed (rather than reporting `steps: 0, trace: []` as if nothing
 * happened). The video already shows the agent making progress; the JSON
 * trace should match.
 */
interface TrialProgress {
  trace: TraceEntry[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
  agentAnswer: string;
  finalUrl: string;
  parts: unknown[];
}

/**
 * Resolve a harness's `subagents` array (a mix of built-in slugs and
 * custom `SubagentDef` objects) into concrete `AgentDefinition`s the
 * delegate tool can dispatch to.
 *
 * Built-in slugs (`"explore"`, `"general"`) load the shipped extension
 * definition and **intersect** its `allowedTools` against the harness's
 * own tool names — built-ins are generic, so unavailable tools are
 * silently dropped (e.g. a vision-only harness without `executeOnPage`
 * still gets a working `general` subagent that just lacks JS exec).
 * Custom `SubagentDef`s are passed through with their (already-validated)
 * tool list intact.
 */
async function resolveHarnessSubagents(
  entries: import("./harness").SubagentEntry[],
  harnessTools: import("@agent/types").BrowserTool<unknown, unknown>[],
): Promise<AgentDefinition[]> {
  if (entries.length === 0) return [];
  const harnessToolNames = new Set(harnessTools.map((t) => t.name));

  // Lazy-load the built-in registry once per resolution. Built-ins are pure
  // type-only data (`AgentDefinition` constants) so importing them here is
  // safe — no chatDb / chrome dependency leaks into the bench process.
  let builtInsLoaded = false;
  let exploreAgent: AgentDefinition | undefined;
  let generalAgent: AgentDefinition | undefined;
  const loadBuiltIns = async () => {
    if (builtInsLoaded) return;
    const [{ exploreAgent: e }, { generalAgent: g }] = await Promise.all([
      import("@agent/subagents/built-ins/explore"),
      import("@agent/subagents/built-ins/general"),
    ]);
    exploreAgent = e;
    generalAgent = g;
    builtInsLoaded = true;
  };

  const resolved: AgentDefinition[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      await loadBuiltIns();
      const builtIn =
        entry === "explore" ? exploreAgent : entry === "general" ? generalAgent : undefined;
      if (!builtIn) {
        // Defensive: harness Zod schema already restricted to known slugs.
        throw new Error(`Unknown built-in subagent slug "${entry}".`);
      }
      resolved.push({
        ...builtIn,
        // Intersect allowedTools with what this harness actually provides.
        allowedTools: builtIn.allowedTools.filter((n) => harnessToolNames.has(n)),
      });
    } else {
      resolved.push({
        slug: entry.slug,
        description: entry.description,
        whenToUse: entry.whenToUse,
        systemPrompt: entry.systemPrompt,
        defaultIsolation: "peer",
        allowedTools: entry.allowedTools,
        ...(entry.deniedTools ? { deniedTools: entry.deniedTools } : {}),
        ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
        ...(entry.maxSteps ? { maxSteps: entry.maxSteps } : {}),
        source: "user",
      });
    }
  }
  return resolved;
}

export async function runTrial(
  task: BenchmarkTask,
  config: TrialConfig,
): Promise<TrialResult> {
  const HARD_TIMEOUT = config.timeoutMs ?? task.timeoutMs ?? 15 * 60_000;
  const HARD_BUFFER = 30_000;

  // Compute the video path here so both the watchdog and `runTrialInner`'s
  // normal finally block can refer to the same destination. Keeping this
  // in `runTrial` scope means the watchdog can save the video without
  // having to reach into `runTrialInner`'s locals.
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

  // We need to keep a reference to the kernel driver if one is created
  // so the hard timeout can clean it up.
  let kernelDriverRef: KernelDriver | undefined;

  // Shared progress — `runTrialInner` writes into this as work happens, and
  // the timeout watchdog reads from it if it has to kill the trial mid-flight.
  const progress: TrialProgress = {
    trace: [],
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    agentAnswer: "",
    finalUrl: "",
    parts: [],
  };

  const trialPromise = runTrialInner(task, config, plannedVideoPath, (driver) => {
    if (driver instanceof KernelDriver) {
      kernelDriverRef = driver;
    }
  }, progress);

  const timeoutPromise = new Promise<TrialResult>((resolve) => {
    setTimeout(async () => {
      // Try to stop + download the Kernel replay before cleaning up the
      // session. `closeAndSaveVideo` is re-entrant: if the normal `finally`
      // block in `runTrialInner` races and claims ownership first, the
      // watchdog's call becomes a no-op (returns null immediately).
      let savedVideoPath: string | undefined;
      if (kernelDriverRef && plannedVideoPath) {
        const saved = await Promise.race([
          kernelDriverRef.closeAndSaveVideo(plannedVideoPath),
          new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
        ]).catch(() => null);
        if (saved) savedVideoPath = saved;
      }

      // Belt-and-suspenders: if the save timed out and the session is still
      // alive (closeAndSaveVideo never ran or failed before nulling the id),
      // force-clean it. For pooled browsers this releases the pool slot
      // (reuse: false) rather than deleting the browser out from under the
      // pool, which would leak a slot.
      if (kernelDriverRef) {
        await kernelDriverRef.forceCleanup().catch(() => {});
      }

      resolve({
        taskId: task.id,
        modelLabel: config.modelLabel,
        agentModelId: config.modelId,
        systemPromptId: config.systemPromptId ?? "default",
        toolSetId: config.toolSetId ?? `set:${(config.toolNames ?? DEFAULT_TOOL_SET).join("+")}`,
        passed: false,
        agentAnswer: progress.agentAnswer,
        finalUrl: progress.finalUrl,
        durationMs: HARD_TIMEOUT + HARD_BUFFER,
        steps: progress.steps,
        tokens: { in: progress.tokensIn, out: progress.tokensOut, total: progress.tokensIn + progress.tokensOut },
        judge: { passed: false, reasoning: `Runner error: Trial exceeded hard timeout of ${HARD_TIMEOUT + HARD_BUFFER}ms` },
        error: { kind: "infrastructure-error", message: `Trial exceeded hard timeout of ${HARD_TIMEOUT + HARD_BUFFER}ms` },
        trace: progress.trace,
        parts: progress.parts,
        videoPath: savedVideoPath,
      });
    }, HARD_TIMEOUT + HARD_BUFFER);
  });

  return Promise.race([trialPromise, timeoutPromise]);
}

async function runTrialInner(
  task: BenchmarkTask,
  config: TrialConfig,
  plannedVideoPath: string | undefined,
  onDriverLaunched: (driver: PlaywrightDriver) => void,
  progress: TrialProgress,
): Promise<TrialResult> {
  const start = Date.now();
  const trace: TraceEntry[] = progress.trace;

  // Generic terminal outcome captured from any tool returning `_benchOutcome`.
  let terminalOutcome: { kind: string; message: string } | undefined;

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

  try {
    if (config.driverKind === "kernel") {
      try {
        driver = await KernelDriver.launch({
          headless: config.headless ?? false,
          apiKey: process.env.KERNEL_API_KEY,
          stealth: true,
          recordVideoDir: config.videosDir,
          poolId: config.kernelPoolId,
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
        // Stable per-trial conversation id. Non-null so the `delegate` tool
        // (subagent dispatch) and the per-parent concurrency tracker have a
        // key to work with. Bench trials are single-run; no chatDb row exists.
        conversationId: "bench",
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
    const baseSystemPrompt =
      config.harness?.systemPrompt ?? config.systemPrompt ?? buildBenchSystemPrompt();
    const driverForLegend = driver;
    const legendEntries = await buildTabLegendEntries({
      conversationId: "bench",
      ownedLtids: [initialTabId],
      getTab: async (tabId) => {
        const info = await driverForLegend.getTab(tabId).catch(() => null);
        return { url: info?.url, title: info?.title };
      },
      getOrCreateHandle: (_cid, tabId) => String(tabId),
      activeTabId: initialTabId,
    });
    const promptWithLegend = `${baseSystemPrompt}\n\n${renderTabLegend(legendEntries)}`;

    // Resolve tool instances + page-state policy from the harness (when set),
    // else fall back to the no-harness default tool set.
    const harness = config.harness;
    const harnessTools = harness?.tools;
    const subagentDefs: AgentDefinition[] | undefined = harness?.subagents
      ? await resolveHarnessSubagents(harness.subagents, harness.tools)
      : undefined;

    const { agent, transport, getNeedsMidStreamCompaction } = buildBenchAgent(ctx, {
      model: config.model,
      systemPrompt: promptWithLegend,
      tools: harnessTools,
      returnPageStateAfterAction: harness?.returnPageStateAfterAction,
      pageStateFields: harness?.pageStateFields,
      pageStateImageTools: harness?.pageStateImageTools,
      terminalToolNames: harness?.terminalToolNames,
      thinking: config.thinking,
      limits: harness?.limits,
      subagents: subagentDefs,
      onStepFinish: (step) => {
        steps += 1;
        const u = step.usage;
        if (u.inputTokens != null) tokensIn += u.inputTokens;
        if (u.outputTokens != null) tokensOut += u.outputTokens;

        // Mirror progress to the shared TrialProgress so the hard-timeout
        // watchdog has accurate counts if it has to fire mid-trial.
        progress.steps = steps;
        progress.tokensIn = tokensIn;
        progress.tokensOut = tokensOut;

        // Push reasoning text into trace[] BEFORE tool calls for this step,
        // so reasoning shows inline with the actions it influenced. The AI SDK
        // exposes step.reasoning as either a string (legacy) or array of
        // reasoning parts (current). We capture full text per debug request.
        const reasoning = (step as any).reasoning;
        const reasoningText: string =
          typeof reasoning === "string"
            ? reasoning
            : Array.isArray(reasoning)
              ? reasoning
                  .map((r: any) => (typeof r === "string" ? r : r?.text ?? ""))
                  .filter((t: string) => t.length > 0)
                  .join("\n")
              : "";
        if (reasoningText.length > 0) {
          trace.push({
            name: "reasoning",
            input: {},
            output: { text: reasoningText },
          });
        }

        for (const tc of step.toolCalls ?? []) {
          let output = step.toolResults?.find((r) => r.toolCallId === tc.toolCallId)?.output ?? null;

          output = redactImageData(output);

          // Generic terminal-outcome marker: any tool may return
          // `_benchOutcome: { kind, message }` to tag the trial. Capture it
          // and redact from the stored output.
          if (
            output &&
            typeof output === "object" &&
            "_benchOutcome" in (output as any)
          ) {
            const oc = (output as any)._benchOutcome;
            if (oc && typeof oc === "object" && !terminalOutcome) {
              terminalOutcome = {
                kind: String(oc.kind ?? "agent-error"),
                message: String(oc.message ?? oc.kind ?? "terminal outcome"),
              };
            }
            const { _benchOutcome, ...rest } = output as any;
            output = rest;
          }

          // Subagent dispatch: the bench `delegate` tool returns its nested
          // trace + tokens in `_benchTrace` / `_benchTokens`. Lift those into
          // a recursive `subagent` field, aggregate the subagent's tokens into
          // the trial total, and redact the internal fields from the stored
          // output (the model only ever saw the projected finalText).
          const entry: TraceEntry = { name: tc.toolName, input: tc.input, output };
          if (
            tc.toolName === "delegate" &&
            output &&
            typeof output === "object" &&
            "_benchTrace" in (output as any)
          ) {
            const o = output as any;
            const subTokens = o._benchTokens ?? { in: 0, out: 0 };
            entry.subagent = {
              slug: (tc.input as any)?.slug ?? "<unknown>",
              finalText: o.finalText ?? "",
              status: o.status ?? "unknown",
              trace: o._benchTrace ?? [],
              tokens: subTokens,
            };
            // Aggregate subagent tokens into the trial total.
            tokensIn += subTokens.in ?? 0;
            tokensOut += subTokens.out ?? 0;
            progress.tokensIn = tokensIn;
            progress.tokensOut = tokensOut;
            // Redact internal fields from the stored output.
            const { _benchTrace, _benchTokens, ...rest } = o;
            entry.output = rest;
          }

          trace.push(entry);
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
      progress.agentAnswer = agentAnswer;

      // Generic terminal-outcome detection. A tool (e.g. an experiment's
      // bot-block reporter) may return `_benchOutcome: { kind, message }` in
      // its raw output to tag the trial with a specific error kind (e.g.
      // "bot-blocked") without the bench hardcoding any experiment tool name.
      // `terminalOutcome` is captured in onStepFinish from the raw output.
      if (terminalOutcome && !error) {
        error = terminalOutcome;
      }

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
        progress.parts = parts;
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
    progress.finalUrl = finalUrl;
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
