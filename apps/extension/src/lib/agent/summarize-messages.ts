import { storage } from "@/lib/storage";
import {
    buildCompactionPrompt,
    getCompactionSystemPrompt,
    prepareMessagesForSummarization,
    type PrunableMessage,
    resolveCompactionModel,
} from "./compaction";

export interface SummarizeOptions {
  /** Abort the in-flight summary model call. */
  signal?: AbortSignal;
  /**
   * A prior summary to anchor on. When provided, the model updates it
   * (preserve still-true details, drop stale ones, merge new facts) instead
   * of starting fresh — mirrors the live compaction flow's `previousSummary`.
   */
  previousSummary?: string;
}

/**
 * Summarize an arbitrary message list into a single compaction-style summary
 * using the user's configured compaction model.
 *
 * Standalone by design: no chatDb writes and no coupling to the live
 * conversation compaction flow (that lives in `useAgentChat.runCompaction`,
 * which also persists a `data-compaction` event). This is the reusable
 * summarization engine — chat mentions call it to condense a long referenced
 * conversation down to its gist instead of pasting/truncating the full
 * transcript.
 *
 * Returns `null` when summarization can't run — no compaction model
 * configured, empty input, aborted, or a model error — so callers can fall
 * back gracefully (e.g. to a truncated transcript).
 */
export async function summarizeMessages(
  messages: PrunableMessage[],
  opts: SummarizeOptions = {},
): Promise<string | null> {
  const conversationText = prepareMessagesForSummarization(messages);
  if (!conversationText.trim()) return null;

  try {
    const agentSettings = await storage.getAgentSettings();
    const settings = await storage.getSettings();
    const compactionModelId =
      agentSettings.compactionModel || agentSettings.agentModel;

    // Model keys are stored composite ("providerId:modelId"); resolve to a
    // provider + bare model id. Mirrors `runCompaction`'s resolution.
    const { providers } = await import("@/registry/providers");
    const resolved = resolveCompactionModel(compactionModelId, providers);
    if (!resolved) return null;

    const config = settings.providerConfigs[resolved.provider.id] ?? {};
    const model = await resolved.provider.createLanguageModel(
      config,
      resolved.modelId,
    );

    const { generateText } = await import("ai");
    const result = await generateText({
      model,
      system: getCompactionSystemPrompt(),
      prompt: `${conversationText}\n\n${buildCompactionPrompt(opts.previousSummary)}`,
      abortSignal: opts.signal,
    });

    if (opts.signal?.aborted) return null;
    const text = result.text.trim();
    return text || null;
  } catch (e) {
    console.warn("[summarizeMessages] summary failed:", e);
    return null;
  }
}
