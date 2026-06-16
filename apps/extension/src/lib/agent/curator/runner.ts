import { ToolLoopAgent, stepCountIs } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { CURATOR_SYSTEM_PROMPT } from "./prompt";
import { dequeueCuratorJob, type CuratorJob } from "./queue";

let draining = false;

export interface DrainOptions {
  /** Injected per-job worker (the real one builds + runs the curator agent). */
  runAgent: (job: CuratorJob) => Promise<void>;
  /** When true, log drain lifecycle to the console with a `[curator]` prefix. */
  debug?: boolean;
}

/**
 * Drain the curator queue serially. Reentrancy-safe: if a drain is already
 * running, a second call returns immediately (the in-flight drain will pick
 * up newly enqueued jobs). Per-job errors are logged and skipped.
 */
export async function drainCuratorQueue(opts: DrainOptions): Promise<void> {
  if (draining) {
    if (opts.debug)
      console.warn("[curator] drain: already running, skipping re-entry");
    return;
  }
  draining = true;
  let processed = 0;
  try {
    for (;;) {
      const job = await dequeueCuratorJob();
      if (!job) break;
      if (opts.debug)
        console.warn(
          `[curator] drain: processing job conv=${job.conversationId} domain=${job.domain}`,
        );
      try {
        await opts.runAgent(job);
        processed += 1;
      } catch (err) {
        console.warn(
          `[curator] job failed (conv=${job.conversationId} domain=${job.domain}):`,
          err,
        );
      }
    }
  } finally {
    draining = false;
    if (opts.debug)
      console.warn(`[curator] drain: done (${processed} job(s) processed)`);
  }
}

/** Max curator agent steps per job (per design decision). */
const CURATOR_MAX_STEPS = 30;

export interface RunCuratorJobDeps {
  /** Resolved ai-SDK LanguageModel for the curator (curatorModel || foreground). */
  model: LanguageModel;
  /**
   * The curator's toolset: Read (scoped to /skills/) + patch_site_skill,
   * already adapted to ai-SDK tools by the caller. Replay-only — no tab tools.
   */
  tools: ToolSet;
  /** When true, log job lifecycle (start, step count, patch calls) to console. */
  debug?: boolean;
}

/**
 * Run the replay-only curator agent for a single job. Builds a fresh
 * ToolLoopAgent (30-step cap) with the injected model + tools and hands it the
 * job's candidates + tool history. The agent decides what to author/update via
 * patch_site_skill. Errors propagate to the drain loop, which logs + continues.
 */
export async function runCuratorJob(
  job: CuratorJob,
  deps: RunCuratorJobDeps,
): Promise<void> {
  const userPrompt = [
    `Domain: ${job.domain}`,
    ``,
    job.candidates.length
      ? `Candidate reusable scripts the main agent ran this session (full code + observed result):`
      : `No reusable script candidates were extracted this session. Focus on durable SITE NOTES: study the tool history below for friction (errored or timed-out tool calls, retries, dead-end navigations, overlays) and record concise lessons that would help future runs on this domain.`,
    ...job.candidates.map(
      (c, i) =>
        `\n--- candidate ${i + 1} ---\ncode:\n${c.code}\nobserved result (truncated): ${c.observedResult}`,
    ),
    ``,
    `Full tool-call history for context:`,
    job.toolHistory,
  ].join("\n");

  const agent = new ToolLoopAgent({
    model: deps.model,
    instructions: CURATOR_SYSTEM_PROMPT,
    tools: deps.tools,
    stopWhen: stepCountIs(CURATOR_MAX_STEPS),
  });

  if (deps.debug)
    console.warn(
      `[curator] job start domain=${job.domain} candidates=${job.candidates.length}`,
    );

  const result = await agent.generate({ prompt: userPrompt });

  if (deps.debug) {
    // Count patch_site_skill tool calls the curator made (its only mutation).
    const patchCalls = (result.steps ?? []).reduce(
      (n, s) =>
        n +
        (s.toolCalls ?? []).filter((t) => t.toolName === "patch_site_skill")
          .length,
      0,
    );
    console.warn(
      `[curator] job done domain=${job.domain} steps=${result.steps?.length ?? 0} patch_site_skill_calls=${patchCalls}`,
    );
  }
}
