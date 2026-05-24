import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { WEBBENCH_REVISION } from "./revision";
import type { BenchmarkTask } from "../types";
import { benchRoot } from "../../paths";

const CACHE_DIR = path.resolve(benchRoot(), "cache");
const CACHE_FILE = path.resolve(CACHE_DIR, `webbench-${WEBBENCH_REVISION}.json`);
const WEBBENCH_URL = `https://raw.githubusercontent.com/Halluminate/WebBench/main/webbenchfinal.csv`;

export async function loadWebBench(): Promise<BenchmarkTask[]> {
  try {
    const cached = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(cached) as BenchmarkTask[];
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.warn(`Warning: failed to read cached WebBench data: ${err.message}`);
    }
    console.log(`Downloading WebBench dataset...`);
    
    await fs.mkdir(CACHE_DIR, { recursive: true });
    
    // Fetch directly from github instead of huggingface since it seems to be public there without auth requirements
    const response = await fetch(WEBBENCH_URL);
    if (!response.ok) {
      throw new Error(`Failed to download WebBench dataset: ${response.statusText}`);
    }
    
    const csvContent = await response.text();
    
    // Parse CSV
    const records = parseCsv(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });
    
    const tasks: BenchmarkTask[] = [];
    
    for (const record of records) {
      const rec = record as any;
      // We only care about READ tasks for the public bench right now
      if (rec.Category === "READ") {
        tasks.push({
          id: `webbench-${rec.ID}`,
          instruction: rec.Task,
          startUrl: rec["Starting URL"],
          category: "extraction", // Map everything to extraction for simplicity
          source: "webbench",
          evaluator: {
            kind: "llm-judge",
            // Generic rubric handled by the judge itself
            rubric: "generic", 
          },
          timeoutMs: 10 * 60_000,
          maxSteps: 30,
        });
      }
    }
    
    // Cache as JSON for fast loading next time
    await fs.writeFile(CACHE_FILE, JSON.stringify(tasks, null, 2));
    console.log(`Successfully downloaded and cached ${tasks.length} WebBench READ tasks.`);
    
    return tasks;
  }
}
