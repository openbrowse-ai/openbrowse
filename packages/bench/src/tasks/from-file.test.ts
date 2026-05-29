import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasksFromFile } from "./from-file";
import type { BenchmarkTask } from "./types";

describe("loadTasksFromFile", () => {
  it("reads a list of task IDs and resolves them via the provided lookup", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-tasks-"));
    const p = join(tmp, "tasks.txt");
    writeFileSync(
      p,
      `
# A comment
task-1

task-2
# Another comment
    `,
    );

    const mockLookup = async (id: string) => {
      if (id === "task-1") return { id: "task-1" } as BenchmarkTask;
      if (id === "task-2") return { id: "task-2" } as BenchmarkTask;
      return undefined;
    };

    const tasks = await loadTasksFromFile(p, mockLookup);
    
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("task-1");
    expect(tasks[1].id).toBe("task-2");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws if any task ID cannot be resolved", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-tasks-"));
    const p = join(tmp, "tasks.txt");
    writeFileSync(p, "task-1\nmissing-1\nmissing-2");

    const mockLookup = async (id: string) => {
      if (id === "task-1") return { id: "task-1" } as BenchmarkTask;
      return undefined;
    };

    await expect(loadTasksFromFile(p, mockLookup)).rejects.toThrow(
      /Unknown task ids.*missing-1.*missing-2/s,
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws if the file does not exist", async () => {
    await expect(
      loadTasksFromFile("/does/not/exist/tasks.txt", async () => undefined),
    ).rejects.toThrow(/ENOENT/);
  });
});
