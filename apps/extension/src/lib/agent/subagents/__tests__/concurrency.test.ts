import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SUBAGENTS_PER_PARENT,
  acquireSubagentSlot,
  activeSubagentCount,
  releaseSubagentSlot,
  resetSubagentSlotsForTesting,
} from "../concurrency";

describe("subagent concurrency slots", () => {
  afterEach(() => {
    resetSubagentSlotsForTesting();
  });

  it("starts with zero active subagents per parent", () => {
    expect(activeSubagentCount("parent-A")).toBe(0);
  });

  it("acquireSubagentSlot increments the count", () => {
    acquireSubagentSlot("parent-A");
    expect(activeSubagentCount("parent-A")).toBe(1);
  });

  it("releaseSubagentSlot decrements the count", () => {
    acquireSubagentSlot("parent-A");
    acquireSubagentSlot("parent-A");
    releaseSubagentSlot("parent-A");
    expect(activeSubagentCount("parent-A")).toBe(1);
  });

  it("counts are isolated per parent conversation", () => {
    acquireSubagentSlot("parent-A");
    acquireSubagentSlot("parent-B");
    expect(activeSubagentCount("parent-A")).toBe(1);
    expect(activeSubagentCount("parent-B")).toBe(1);
  });

  it("releasing below zero clamps to zero", () => {
    releaseSubagentSlot("parent-A");
    releaseSubagentSlot("parent-A");
    expect(activeSubagentCount("parent-A")).toBe(0);
  });

  it("acquireSubagentSlot throws once the cap is reached", () => {
    for (let i = 0; i < MAX_SUBAGENTS_PER_PARENT; i++) {
      acquireSubagentSlot("parent-A");
    }
    expect(() => acquireSubagentSlot("parent-A")).toThrow(/concurrency/i);
    expect(activeSubagentCount("parent-A")).toBe(MAX_SUBAGENTS_PER_PARENT);
  });

  it("MAX_SUBAGENTS_PER_PARENT is 10", () => {
    expect(MAX_SUBAGENTS_PER_PARENT).toBe(10);
  });
});
