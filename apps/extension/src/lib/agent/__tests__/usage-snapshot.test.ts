import type { ModelDefinition } from "@/registry/providers/types";
import { describe, expect, it } from "vitest";
import { nextUsageSnapshot } from "../usage-snapshot";

const model: ModelDefinition = {
  id: "claude-x",
  name: "Claude X",
  capabilities: ["chat"],
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  pricing: { inputPer1M: 3, outputPer1M: 15 },
};

const modelNoPricing: ModelDefinition = {
  id: "local-x",
  name: "Local X",
  capabilities: ["chat"],
  contextWindow: 8_192,
};

describe("nextUsageSnapshot", () => {
  it("computes totals and cost from the first step", () => {
    const next = nextUsageSnapshot(
      undefined,
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      model,
      "anthropic:claude-x",
      123,
    );
    expect(next.inputTokens).toBe(1_000_000);
    expect(next.outputTokens).toBe(1_000_000);
    expect(next.totalTokens).toBe(2_000_000);
    // 1M input * $3 + 1M output * $15 = $18
    expect(next.costUsd).toBeCloseTo(18, 6);
    expect(next.contextWindow).toBe(200_000);
    expect(next.maxOutputTokens).toBe(32_000);
    expect(next.modelId).toBe("anthropic:claude-x");
    expect(next.updatedAt).toBe(123);
  });

  it("overwrites totalTokens but accumulates cost across steps", () => {
    const first = nextUsageSnapshot(
      undefined,
      { inputTokens: 1_000_000, outputTokens: 0 },
      model,
      "anthropic:claude-x",
      1,
    );
    // first cost = 1M * $3 = $3
    expect(first.costUsd).toBeCloseTo(3, 6);

    const second = nextUsageSnapshot(
      first,
      { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      model,
      "anthropic:claude-x",
      2,
    );
    // totalTokens overwrites: 2M + 1M = 3M (NOT added to the prior 1M)
    expect(second.totalTokens).toBe(3_000_000);
    // cost accumulates: $3 + (2M*$3 + 1M*$15) = $3 + $21 = $24
    expect(second.costUsd).toBeCloseTo(24, 6);
  });

  it("treats missing token fields as zero", () => {
    const next = nextUsageSnapshot(
      undefined,
      { inputTokens: undefined, outputTokens: undefined },
      model,
      "anthropic:claude-x",
      5,
    );
    expect(next.inputTokens).toBe(0);
    expect(next.outputTokens).toBe(0);
    expect(next.totalTokens).toBe(0);
    expect(next.costUsd).toBe(0);
  });

  it("adds zero cost when the model has no pricing", () => {
    const first = nextUsageSnapshot(
      undefined,
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      modelNoPricing,
      "local:local-x",
      1,
    );
    expect(first.costUsd).toBe(0);
    const second = nextUsageSnapshot(
      first,
      { inputTokens: 1_000_000, outputTokens: 0 },
      modelNoPricing,
      "local:local-x",
      2,
    );
    expect(second.costUsd).toBe(0);
    expect(second.totalTokens).toBe(1_000_000);
  });

  it("falls back to 0 contextWindow when the model omits it", () => {
    const next = nextUsageSnapshot(
      undefined,
      { inputTokens: 10, outputTokens: 10 },
      { id: "m", name: "M", capabilities: ["chat"] },
      "p:m",
      1,
    );
    expect(next.contextWindow).toBe(0);
  });

  it("accumulates distinct model ids in first-seen order", () => {
    const first = nextUsageSnapshot(
      undefined,
      { inputTokens: 10, outputTokens: 10 },
      model,
      "anthropic:claude-x",
      1,
    );
    expect(first.modelIds).toEqual(["anthropic:claude-x"]);

    // Same model again — no duplicate.
    const second = nextUsageSnapshot(
      first,
      { inputTokens: 10, outputTokens: 10 },
      model,
      "anthropic:claude-x",
      2,
    );
    expect(second.modelIds).toEqual(["anthropic:claude-x"]);

    // New model — appended after the first.
    const third = nextUsageSnapshot(
      second,
      { inputTokens: 10, outputTokens: 10 },
      model,
      "openai:gpt-x",
      3,
    );
    expect(third.modelIds).toEqual(["anthropic:claude-x", "openai:gpt-x"]);
    expect(third.modelId).toBe("openai:gpt-x");
  });

  it("never adds an empty model id to the list", () => {
    const next = nextUsageSnapshot(
      undefined,
      { inputTokens: 10, outputTokens: 10 },
      model,
      "",
      1,
    );
    expect(next.modelIds).toEqual([]);
  });

  it("carries a legacy prev.modelId into modelIds when the list is absent", () => {
    // Simulate a snapshot written before `modelIds` existed: it has a
    // single `modelId` but no `modelIds` array.
    const legacy = {
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      costUsd: 1,
      contextWindow: 200_000,
      modelId: "anthropic:claude-x",
      updatedAt: 1,
    };
    const next = nextUsageSnapshot(
      legacy,
      { inputTokens: 10, outputTokens: 10 },
      model,
      "openai:gpt-x",
      2,
    );
    // The legacy model is preserved first, then the new one appended.
    expect(next.modelIds).toEqual(["anthropic:claude-x", "openai:gpt-x"]);

    // When the legacy model matches the current one, no duplicate.
    const same = nextUsageSnapshot(
      legacy,
      { inputTokens: 10, outputTokens: 10 },
      model,
      "anthropic:claude-x",
      3,
    );
    expect(same.modelIds).toEqual(["anthropic:claude-x"]);
  });
});
