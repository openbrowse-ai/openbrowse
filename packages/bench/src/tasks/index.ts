/**
 * Aggregate registry of all benchmark tasks the CLI knows about. New task
 * suites are added by appending here.
 */

import { SMOKE_TASKS } from "./smoke";
import { WEBBENCH_SUBSET } from "./webbench";
import { loadWebBench } from "./webbench/loader";
import type { BenchmarkTask, TaskSource } from "./types";

export const ALL_TASKS: BenchmarkTask[] = [
  ...SMOKE_TASKS,
  ...WEBBENCH_SUBSET,
];

// Lazy-loaded webbench tasks to prevent blocking the CLI
let lazyWebBenchTasks: BenchmarkTask[] | null = null;

export async function findTask(id: string): Promise<BenchmarkTask | undefined> {
  const t = ALL_TASKS.find((t) => t.id === id);
  if (t) return t;
  
  if (id.startsWith("webbench-")) {
    if (!lazyWebBenchTasks) lazyWebBenchTasks = await loadWebBench();
    return lazyWebBenchTasks.find(t => t.id === id);
  }
  
  return undefined;
}

export async function tasksBySource(source: TaskSource | "webbench-mini"): Promise<BenchmarkTask[]> {
  if (source === "custom") return SMOKE_TASKS;
  if (source === "webbench") {
    if (!lazyWebBenchTasks) lazyWebBenchTasks = await loadWebBench();
    return lazyWebBenchTasks;
  }
  if (source === "webbench-mini") {
    if (!lazyWebBenchTasks) lazyWebBenchTasks = await loadWebBench();
    // Seeded selection of 50 tasks so it's consistent across runs
    return lazyWebBenchTasks.filter((_, i) => i % 31 === 0).slice(0, 50);
  }
  
  return ALL_TASKS.filter((t) => t.source === source);
}

export async function getAllTasks(): Promise<BenchmarkTask[]> {
  if (!lazyWebBenchTasks) lazyWebBenchTasks = await loadWebBench();
  return [...ALL_TASKS, ...lazyWebBenchTasks];
}
