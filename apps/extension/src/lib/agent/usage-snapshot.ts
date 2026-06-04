import type { ModelDefinition } from "@/registry/providers/types";
import type { ConversationUsage } from "../types";

/**
 * A finished step's token usage, as reported by the AI SDK's
 * `onStepFinish` callback (`stepResult.usage`). Both fields may be
 * undefined for providers that don't report them.
 */
export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Compute the next conversation usage snapshot from the previous snapshot
 * and a finished step.
 *
 * - `inputTokens`/`outputTokens`/`totalTokens` OVERWRITE — they reflect the
 *   current context occupancy (the SDK reports the full growing context as
 *   the step's input each call), so the latest step is the source of truth.
 * - `costUsd` ACCUMULATES — each step's spend is added to the running total.
 *   Missing pricing contributes 0.
 * - `modelIds` ACCUMULATES — the latest `modelId` is appended (deduped,
 *   first-seen order) so the UI knows every model that contributed to the
 *   cumulative cost across a multi-model conversation.
 *
 * `modelId` is the fully-qualified `provider:model` key (e.g.
 * "anthropic:claude-x"), which is distinct from `model.id` ("claude-x").
 * Pass the qualified key, not `model?.id`.
 */
export function nextUsageSnapshot(
  prev: ConversationUsage | undefined,
  step: StepUsage,
  model: ModelDefinition | undefined,
  modelId: string,
  now: number,
): ConversationUsage {
  const inputTokens = step.inputTokens ?? 0;
  const outputTokens = step.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  const pricing = model?.pricing;
  const stepCost = pricing
    ? (inputTokens / 1_000_000) * pricing.inputPer1M +
      (outputTokens / 1_000_000) * pricing.outputPer1M
    : 0;

  // Append this step's model to the distinct first-seen list. Skip empty
  // ids so a missing key never pollutes the list.
  const modelIds = [...(prev?.modelIds ?? [])];
  if (modelId && !modelIds.includes(modelId)) modelIds.push(modelId);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: (prev?.costUsd ?? 0) + stepCost,
    contextWindow: model?.contextWindow ?? 0,
    modelId,
    modelIds,
    updatedAt: now,
  };
}
