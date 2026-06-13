import { describe, expect, it } from "vitest";
import type { TodoItem } from "@/lib/types";
import { planSummary } from "../plan-summary";

function todo(status: TodoItem["status"], content = "task"): TodoItem {
  return {
    id: "t",
    content,
    status,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("planSummary", () => {
  it("counts completed over total", () => {
    const todos = [todo("completed"), todo("completed"), todo("pending")];
    expect(planSummary(todos)).toEqual({ done: 2, total: 3, live: null });
  });

  it("surfaces the first in_progress task content as the live line", () => {
    const todos = [
      todo("completed"),
      todo("in_progress", "Cross-reference Crunchbase"),
      todo("in_progress", "second concurrent"),
      todo("pending"),
    ];
    expect(planSummary(todos)).toEqual({
      done: 1,
      total: 4,
      live: "Cross-reference Crunchbase",
    });
  });

  it("handles empty input", () => {
    expect(planSummary([])).toEqual({ done: 0, total: 0, live: null });
  });

  it("counts cancelled tasks in total but not done", () => {
    const todos = [todo("cancelled"), todo("completed")];
    expect(planSummary(todos)).toEqual({ done: 1, total: 2, live: null });
  });
});
