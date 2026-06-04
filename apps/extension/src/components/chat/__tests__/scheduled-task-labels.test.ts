import { describe, expect, it } from "vitest";
import { scheduledTaskLabels } from "../ToolCallBlock";

const createFallback = {
  pending: "Scheduling task...",
  done: "Scheduled task",
};
const updateFallback = {
  pending: "Updating scheduled task...",
  done: "Updated scheduled task",
};

describe("scheduledTaskLabels", () => {
  it("create: includes the task name", () => {
    expect(
      scheduledTaskLabels(
        "create_scheduled_task",
        { name: "daily-briefing" },
        createFallback,
      ),
    ).toEqual({
      pending: "Scheduling “daily-briefing”...",
      done: "Scheduled “daily-briefing”",
    });
  });

  it("create: falls back without a name", () => {
    expect(
      scheduledTaskLabels("create_scheduled_task", {}, createFallback),
    ).toBe(createFallback);
  });

  it("update: pause (enabled=false)", () => {
    expect(
      scheduledTaskLabels(
        "update_scheduled_task",
        { name: "brief", enabled: false },
        updateFallback,
      ),
    ).toEqual({ pending: "Pausing “brief”...", done: "Paused “brief”" });
  });

  it("update: resume (enabled=true) without a name", () => {
    expect(
      scheduledTaskLabels(
        "update_scheduled_task",
        { enabled: true },
        updateFallback,
      ),
    ).toEqual({
      pending: "Resuming scheduled task...",
      done: "Resumed scheduled task",
    });
  });

  it("update: general edit shows the name", () => {
    expect(
      scheduledTaskLabels(
        "update_scheduled_task",
        { name: "brief", prompt: "new" },
        updateFallback,
      ),
    ).toEqual({ pending: "Updating “brief”...", done: "Updated “brief”" });
  });

  it("update: falls back with no name and no enabled", () => {
    expect(
      scheduledTaskLabels("update_scheduled_task", { id: "x" }, updateFallback),
    ).toBe(updateFallback);
  });

  it("falls back for unrelated tool names", () => {
    expect(scheduledTaskLabels("list_scheduled_tasks", {}, createFallback)).toBe(
      createFallback,
    );
  });
});
