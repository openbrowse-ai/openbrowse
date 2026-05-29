import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchmarkTask } from "./types";

/**
 * Read a newline-delimited list of task IDs from a file and resolve them
 * into actual tasks. Ignores blank lines and comments (lines starting
 * with `#`). Throws if the file is unreadable or if any ID fails to resolve.
 */
export async function loadTasksFromFile(
  path: string,
  findTask: (id: string) => Promise<BenchmarkTask | undefined>,
): Promise<BenchmarkTask[]> {
  const raw = readFileSync(resolve(path), "utf-8");
  const ids = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));

  const found: BenchmarkTask[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const t = await findTask(id);
    if (t) found.push(t);
    else missing.push(id);
  }

  if (missing.length > 0) {
    throw new Error(`Unknown task ids in ${path}:\n  ${missing.join("\n  ")}`);
  }

  return found;
}
