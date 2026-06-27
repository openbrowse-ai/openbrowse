import { OPFS } from "@/lib/vfs/opfs";

const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

function ensureKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`invalid kv key: ${JSON.stringify(key)}`);
  if (key.includes("..") || key.includes("/")) throw new Error("kv key may not contain .. or /");
}

function path(artifactId: string, key: string): string {
  return `artifacts/${artifactId}/kv/${key}.json`;
}

export async function kvGet(artifactId: string, key: string): Promise<unknown | undefined> {
  ensureKey(key);
  const p = path(artifactId, key);
  if (!(await OPFS.exists(p))) return undefined;
  const raw = await OPFS.readFile(p);
  try { return JSON.parse(raw); } catch { return undefined; }
}

export async function kvSet(artifactId: string, key: string, value: unknown): Promise<void> {
  ensureKey(key);
  await OPFS.writeFileAtomic(path(artifactId, key), JSON.stringify(value));
}

export async function kvDelete(artifactId: string, key: string): Promise<void> {
  ensureKey(key);
  const p = path(artifactId, key);
  if (await OPFS.exists(p)) await OPFS.rm(p);
}

export async function kvKeys(artifactId: string): Promise<string[]> {
  const dir = `artifacts/${artifactId}/kv`;
  if (!(await OPFS.exists(dir))) return [];
  const entries = await OPFS.readDir(dir);
  return entries.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
}
