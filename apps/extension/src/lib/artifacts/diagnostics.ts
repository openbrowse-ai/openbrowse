/**
 * Cross-context diagnostics buffer for a running artifact.
 *
 * The artifact runtime (Host.tsx, in the artifact tab or the inline chat card)
 * forwards the artifact iframe's console output, uncaught errors, and a
 * one-shot "rendered" signal here. The `read_artifact_diagnostics` agent tool —
 * which executes in a different extension context (background / side panel) —
 * reads them back so the agent can verify the artifact actually loaded and
 * rendered after `create_artifact`, and iterate via `update_artifact`.
 *
 * We use `chrome.storage.local` (not `chrome.storage.session`) for the same
 * reason as pending-fix-request.ts: session storage is partitioned so a regular
 * extension tab (the artifact) and the agent's context do NOT see each other's
 * values, whereas `local` is shared across all extension contexts.
 *
 * Entries are keyed by artifact id, bounded, and cleared when the artifact is
 * re-run (Host mount), deleted, or considered stale.
 */

const KEY_PREFIX = "openbrowse:artifact-diagnostics:";

/** Per-run cap on buffered console/error entries (oldest dropped first). */
export const DIAGNOSTICS_MAX_ENTRIES = 50;

/** Diagnostics older than this (since `startedAt`) are treated as stale. */
export const DIAGNOSTICS_TTL_MS = 10 * 60_000;

export interface DiagnosticsConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  text: string;
  ts: number;
}

export interface DiagnosticsErrorEntry {
  message: string;
  stack?: string;
  sourceFile?: string;
  recentConsole?: string[];
  ts: number;
}

export interface DiagnosticsRendered {
  /** Number of direct children in the artifact <body> at render time. */
  childCount: number;
  /** First ~200 chars of the body's text content (trimmed). */
  bodyTextSample: string;
  ts: number;
}

export interface ArtifactDiagnostics {
  artifactId: string;
  /** When this run's buffer was first opened (first recorded signal). */
  startedAt: number;
  console: DiagnosticsConsoleEntry[];
  errors: DiagnosticsErrorEntry[];
  /** Set once the artifact reports it finished its initial render. */
  rendered: DiagnosticsRendered | null;
}

function storageKey(artifactId: string): string {
  return `${KEY_PREFIX}${artifactId}`;
}

function emptyDiagnostics(artifactId: string): ArtifactDiagnostics {
  return { artifactId, startedAt: Date.now(), console: [], errors: [], rendered: null };
}

async function load(artifactId: string): Promise<ArtifactDiagnostics | null> {
  const key = storageKey(artifactId);
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as ArtifactDiagnostics | undefined) ?? null;
}

async function save(d: ArtifactDiagnostics): Promise<void> {
  await chrome.storage.local.set({ [storageKey(d.artifactId)]: d });
}

// Serialize read-modify-write per artifact id. Console output can arrive in
// bursts; without this, concurrent load→mutate→save cycles would clobber each
// other and drop entries. Each artifact gets a tail promise that the next
// mutation awaits before running.
//
// CAVEAT (I3): this map is per JS context. It prevents clobbering WITHIN a
// context, but two contexts rendering the SAME artifact simultaneously (e.g.
// open in a standalone tab AND in the home embed viewer) do read-modify-write
// against the same storage.local key without cross-context serialization and
// can drop entries. In practice exactly one renderer is live per artifact, so
// we accept this; revisit (e.g. key buffers by render-instance) if simultaneous
// renderers become common.
const writeChains = new Map<string, Promise<void>>();

function enqueue(artifactId: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(artifactId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain from rejecting permanently; swallow per-op errors (best-effort).
  writeChains.set(
    artifactId,
    next.catch(() => {}),
  );
  return next;
}

function cap<T>(arr: T[]): T[] {
  return arr.length > DIAGNOSTICS_MAX_ENTRIES
    ? arr.slice(arr.length - DIAGNOSTICS_MAX_ENTRIES)
    : arr;
}

/** Append a console entry (creating the buffer if needed). */
export async function recordConsole(
  artifactId: string,
  entry: DiagnosticsConsoleEntry,
): Promise<void> {
  return enqueue(artifactId, async () => {
    const d = (await load(artifactId)) ?? emptyDiagnostics(artifactId);
    d.console = cap([...d.console, entry]);
    await save(d);
  });
}

/** Append an error entry (creating the buffer if needed). */
export async function recordError(
  artifactId: string,
  entry: DiagnosticsErrorEntry,
): Promise<void> {
  return enqueue(artifactId, async () => {
    const d = (await load(artifactId)) ?? emptyDiagnostics(artifactId);
    d.errors = cap([...d.errors, entry]);
    await save(d);
  });
}

/** Record the one-shot render signal (creating the buffer if needed). */
export async function recordRendered(
  artifactId: string,
  rendered: DiagnosticsRendered,
): Promise<void> {
  return enqueue(artifactId, async () => {
    const d = (await load(artifactId)) ?? emptyDiagnostics(artifactId);
    d.rendered = rendered;
    await save(d);
  });
}

/**
 * Read the current diagnostics for an artifact. Returns null when none recorded
 * or when the buffer is older than the TTL (stale runs are discarded so the
 * agent never reads a previous session's output).
 */
export async function readDiagnostics(
  artifactId: string,
  now = Date.now(),
): Promise<ArtifactDiagnostics | null> {
  const d = await load(artifactId);
  if (!d) return null;
  if (now - d.startedAt > DIAGNOSTICS_TTL_MS) {
    await clearDiagnostics(artifactId);
    return null;
  }
  return d;
}

/** Drop an artifact's diagnostics buffer (e.g. before a fresh run, or on delete). */
export async function clearDiagnostics(artifactId: string): Promise<void> {
  // Chain the clear after any in-flight writes so it can't be clobbered by a
  // record() that resolves just after it.
  const done = enqueue(artifactId, async () => {
    await chrome.storage.local.remove(storageKey(artifactId));
  });
  // Once this clear settles, drop the chain entry so `writeChains` doesn't grow
  // unbounded (one resolved-promise tail per artifact id ever touched). Only
  // delete if the tail is still the one we just set — a record() enqueued after
  // us would have replaced it, and that newer chain must be preserved.
  const tail = writeChains.get(artifactId);
  void done.finally(() => {
    if (writeChains.get(artifactId) === tail) {
      writeChains.delete(artifactId);
    }
  });
  return done;
}
