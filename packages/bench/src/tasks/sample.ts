import type { BenchmarkTask } from "./types";

/**
 * Fast, seedable PRNG (Mulberry32).
 * https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 */
function mulberry32(a: number): () => number {
  return function () {
    var t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Get the domain from a task's startUrl. 
 * Strips 'www.' to group effectively.
 */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Stratified sampling by domain.
 * Ensures maximum domain diversity for any given sample size.
 * Uses a deterministic seed so two runs with the same parameters
 * yield the exact same task list.
 */
export function sampleTasks(
  tasks: BenchmarkTask[],
  sampleSize: number,
  seed: number
): BenchmarkTask[] {
  if (sampleSize >= tasks.length || sampleSize <= 0) return tasks;

  const rng = mulberry32(seed);

  // 1. Group tasks by domain
  const byDomain = new Map<string, BenchmarkTask[]>();
  for (const t of tasks) {
    const d = getDomain(t.startUrl);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(t);
  }

  // 2. Shuffle tasks within each domain
  for (const list of byDomain.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  // 3. Shuffle the domain order itself so we don't always favor domains
  // that happen to sort first alphabetically.
  const domains = Array.from(byDomain.keys());
  for (let i = domains.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [domains[i], domains[j]] = [domains[j], domains[i]];
  }

  // 4. Round-robin pick tasks from domains until we hit sampleSize
  const selected: BenchmarkTask[] = [];
  const domainIndices = new Map<string, number>(); // track where we are in each domain's list
  for (const d of domains) domainIndices.set(d, 0);

  let activeDomains = [...domains];
  while (selected.length < sampleSize && activeDomains.length > 0) {
    const nextActive: string[] = [];
    for (const d of activeDomains) {
      if (selected.length >= sampleSize) break;
      
      const list = byDomain.get(d)!;
      const idx = domainIndices.get(d)!;
      
      if (idx < list.length) {
        selected.push(list[idx]);
        domainIndices.set(d, idx + 1);
        if (idx + 1 < list.length) {
          nextActive.push(d); // Domain still has tasks, keep it for next round
        }
      }
    }
    activeDomains = nextActive;
  }

  // 5. Restore original global ordering so logs are consistent
  // and tasks run in predictable order (e.g. webbench-1 before webbench-2)
  const orderMap = new Map(tasks.map((t, i) => [t.id, i]));
  selected.sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!);

  return selected;
}
