import { OPFS } from "../../vfs/opfs";
import type { SiteSkillCandidate } from "../../skills/site-skill-candidates";

export interface CuratorJob {
  conversationId: string;
  domain: string;
  candidates: SiteSkillCandidate[];
  /** Full tool-call history slice for the turn (curator input). */
  toolHistory: string;
  enqueuedAt: number;
}

const QUEUE_PATH = "curator-queue.json";

async function readQueue(): Promise<CuratorJob[]> {
  try {
    const raw = await OPFS.readFile(QUEUE_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(jobs: CuratorJob[]): Promise<void> {
  await OPFS.writeFile(QUEUE_PATH, JSON.stringify(jobs));
}

const key = (j: { conversationId: string; domain: string }) =>
  `${j.conversationId}::${j.domain}`;

/** Append a job, replacing any existing job with the same (conv, domain) key. */
export async function enqueueCuratorJob(
  job: Omit<CuratorJob, "enqueuedAt">,
): Promise<void> {
  const jobs = await readQueue();
  const filtered = jobs.filter((j) => key(j) !== key(job));
  filtered.push({ ...job, enqueuedAt: Date.now() });
  await writeQueue(filtered);
}

/** Pop the oldest job, or null when empty. */
export async function dequeueCuratorJob(): Promise<CuratorJob | null> {
  const jobs = await readQueue();
  const next = jobs.shift();
  if (!next) return null;
  await writeQueue(jobs);
  return next;
}

export async function peekCuratorQueue(): Promise<CuratorJob[]> {
  return readQueue();
}
