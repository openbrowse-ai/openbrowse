/**
 * Tests for read-time usage aggregation.
 *
 * A subagent's tokens and cost accumulate on its OWN child conversation row,
 * so a parent's `usage.costUsd` alone under-reports a delegation-heavy
 * session by most of its actual spend. `sumSubagentCostUsd` closes that gap at
 * READ time rather than by rolling into the parent's row at write time —
 * which matters because the heal paths (`finalizeOrphanedChildrenForHeals`,
 * `finalizeAllRunningChildrenAtStartup`) can finalize the same child more
 * than once, and a write-time roll-up would double-count.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDb } from "../../chat-db";
import type { ConversationUsage } from "../../types";
import {
  occupiedTokens,
  projectedNextPromptTokens,
  sumSubagentCostUsd,
} from "../usage-aggregate";

function usage(partial: Partial<ConversationUsage>): ConversationUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    contextWindow: 200_000,
    modelId: "anthropic:claude-x",
    updatedAt: 1,
    ...partial,
  };
}

describe("sumSubagentCostUsd", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: "parent-1",
      title: "Parent",
      spaceId: "space-A",
      createdAt: 100,
      updatedAt: 100,
      usage: usage({ costUsd: 0.5 }),
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  async function addChild(id: string, costUsd: number | undefined) {
    await chatDb.createConversation({
      id,
      title: id,
      spaceId: "space-A",
      createdAt: 200,
      updatedAt: 200,
      parentConversationId: "parent-1",
      subagentSlug: "explore",
      subagentStatus: "completed",
      ...(costUsd !== undefined && { usage: usage({ costUsd }) }),
    });
  }

  it("returns 0 for a conversation with no children", async () => {
    expect(await sumSubagentCostUsd("parent-1")).toBe(0);
  });

  it("sums cost across every child", async () => {
    await addChild("subagent-1", 1.25);
    await addChild("subagent-2", 0.75);
    expect(await sumSubagentCostUsd("parent-1")).toBeCloseTo(2, 6);
  });

  it("treats a child with no usage row yet as 0 rather than NaN", async () => {
    await addChild("subagent-1", 1.5);
    await addChild("subagent-running", undefined);
    expect(await sumSubagentCostUsd("parent-1")).toBeCloseTo(1.5, 6);
  });

  it("counts a still-running child's spend immediately", async () => {
    await chatDb.createConversation({
      id: "subagent-live",
      title: "live",
      spaceId: "space-A",
      createdAt: 200,
      updatedAt: 200,
      parentConversationId: "parent-1",
      subagentSlug: "general",
      subagentStatus: "running",
      usage: usage({ costUsd: 0.4 }),
    });
    expect(await sumSubagentCostUsd("parent-1")).toBeCloseTo(0.4, 6);
  });

  it("is stable across repeated reads (no write-side accumulation)", async () => {
    await addChild("subagent-1", 1.25);
    const first = await sumSubagentCostUsd("parent-1");
    const second = await sumSubagentCostUsd("parent-1");
    const third = await sumSubagentCostUsd("parent-1");
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("does not attribute another parent's children", async () => {
    await chatDb.createConversation({
      id: "parent-2",
      title: "Other",
      spaceId: "space-A",
      createdAt: 100,
      updatedAt: 100,
    });
    await chatDb.createConversation({
      id: "subagent-other",
      title: "other child",
      spaceId: "space-A",
      createdAt: 200,
      updatedAt: 200,
      parentConversationId: "parent-2",
      subagentSlug: "explore",
      subagentStatus: "completed",
      usage: usage({ costUsd: 99 }),
    });
    expect(await sumSubagentCostUsd("parent-1")).toBe(0);
  });

  it("returns 0 instead of throwing when the lookup fails", async () => {
    chatDb._resetForTests();
    const real = indexedDB;
    try {
      // @ts-expect-error — force the underlying DB away to simulate failure.
      indexedDB = undefined;
      expect(await sumSubagentCostUsd("parent-1")).toBe(0);
    } finally {
      // Restore so this test can't strand a later DB-backed test in the file.
      indexedDB = real;
    }
  });
});

describe("token accessors name which quantity they mean", () => {
  it("occupiedTokens is the latest request's input only", () => {
    expect(
      occupiedTokens(
        usage({
          inputTokens: 120_000,
          outputTokens: 8_000,
          totalTokens: 128_000,
        }),
      ),
    ).toBe(120_000);
  });

  it("projectedNextPromptTokens includes the output that becomes next input", () => {
    expect(
      projectedNextPromptTokens(
        usage({
          inputTokens: 120_000,
          outputTokens: 8_000,
          totalTokens: 128_000,
        }),
      ),
    ).toBe(128_000);
  });

  it("the two differ exactly by the latest output, which is why display and compaction disagree", () => {
    const u = usage({
      inputTokens: 190_000,
      outputTokens: 20_000,
      totalTokens: 210_000,
      contextWindow: 200_000,
    });
    // Occupancy fits the window; the projection does not. Showing the
    // projection is what used to force a 100% clamp in the UI.
    expect(occupiedTokens(u)).toBeLessThan(u.contextWindow);
    expect(projectedNextPromptTokens(u)).toBeGreaterThan(u.contextWindow);
    expect(projectedNextPromptTokens(u) - occupiedTokens(u)).toBe(20_000);
  });
});
