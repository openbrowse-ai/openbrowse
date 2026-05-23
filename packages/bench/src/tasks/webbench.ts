import type { BenchmarkTask } from "./types";

/**
 * Known sites that consistently fail due to infrastructure issues
 * (e.g. CAPTCHAs, bot blocking) even with Kernel's stealth mode enabled.
 * These are excluded from the default benchmark suite to maintain
 * accurate signal for agent reasoning capability.
 * 
 * Empty for v1 - populate empirically based on infrastructureFailureRate > 50%.
 */
export const KNOWN_BROKEN_SITES: string[] = [
];

export const WEBBENCH_SUBSET: BenchmarkTask[] = [
  // TODO: Add 50 hand-curated tasks here with llm-judge rubrics.
];
