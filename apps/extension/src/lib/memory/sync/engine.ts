// src/lib/memory/sync/engine.ts
//
// Three-way per-file reconciliation between the local `memory/**` tree and a
// vault, using a per-profile baseline (`path -> sha256` as of the last sync) as
// the merge base.
//
// Pure with respect to the platform: everything it touches arrives through
// `LocalTreePort` and `MemorySyncTransport`, so the entire case table is
// unit-testable against in-memory fakes.
//
// See docs/superpowers/specs/2026-09-07-memory-sync-design.md.

import { parseMemory } from "../format";
import { classifyRemotePath } from "./paths";
import {
  DEFAULT_SYNC_LIMITS,
  emptyResult,
  type Baseline,
  type FileEntry,
  type LocalTreePort,
  type MemorySyncTransport,
  type SyncLimits,
  type SyncProfile,
  type SyncResult,
  type Tombstone,
  type RemoteFileStat,
} from "./types";

/** What to do with a single path. */
export type Decision =
  | { kind: "noop" }
  /** Local is authoritative; write it to the vault. */
  | { kind: "push" }
  /** Vault is authoritative; write it to OPFS. */
  | { kind: "pull" }
  /** Both sides changed; resolve by last-write-wins and archive the loser. */
  | { kind: "conflict" }
  /** Deleted locally while the vault copy was untouched. */
  | { kind: "delete-remote" }
  /** Deleted in the vault while the local copy was untouched. */
  | { kind: "delete-local" }
  /** A delete raced an edit. The edit wins and the tombstone is dropped. */
  | { kind: "resurrect"; direction: "push" | "pull" }
  /** Gone from both sides; just forget it. */
  | { kind: "drop-baseline" };

export interface DecisionInput {
  /** SHA-256 of the local file, or null when absent. */
  local: string | null;
  /** SHA-256 of the vault file, or null when absent. */
  remote: string | null;
  /** SHA-256 recorded at the last successful sync, or null when unknown. */
  base: string | null;
  /** Whether the vault carries a tombstone for this path. */
  tombstoned: boolean;
}

/**
 * Total decision function. Every combination of presence and hash equality maps
 * to exactly one action.
 *
 * Two biases are deliberate and both favour preserving data:
 *
 * **An edit beats a concurrent delete.** Losing a note you just wrote is worse
 * than seeing one you deleted come back, and the resurrection is reported in
 * the result rather than happening silently.
 *
 * **A vault file that vanished without a tombstone is restored, not treated as
 * a delete.** Deletions performed through OpenBrowse always leave a tombstone.
 * A file that is simply missing is far more likely to be a half-synced cloud
 * folder, an interrupted copy, or a vault the user pruned by hand than an
 * intentional instruction to erase local memory — and reading it as a delete
 * would let one bad sync cascade into wiping the tree.
 */
export function decide(input: DecisionInput): Decision {
  const { local, remote, base, tombstoned } = input;

  if (local !== null && remote !== null) {
    if (local === remote) return { kind: "noop" };
    if (base !== null && base === local) return { kind: "pull" };
    if (base !== null && base === remote) return { kind: "push" };
    // Both sides moved off the base, or there is no base and they disagree.
    return { kind: "conflict" };
  }

  if (local !== null && remote === null) {
    if (tombstoned) {
      // Unmodified locally → accept the remote delete.
      if (base !== null && base === local) return { kind: "delete-local" };
      // Modified locally (or never synced) → the edit wins.
      return { kind: "resurrect", direction: "push" };
    }
    // No tombstone: either a brand-new local file or a vault that lost the
    // file without telling us. Push in both cases.
    return { kind: "push" };
  }

  if (local === null && remote !== null) {
    if (base === null) return { kind: "pull" };
    // Deleted locally. If the vault copy is unchanged since our last sync, the
    // delete is uncontested and propagates.
    if (base === remote) return { kind: "delete-remote" };
    // The vault edited it after our last sync while we deleted it: edit wins.
    return { kind: "resurrect", direction: "pull" };
  }

  // Absent on both sides.
  return base === null ? { kind: "noop" } : { kind: "drop-baseline" };
}

/**
 * Pick the winner of a conflict: the newer `updated` frontmatter date, falling
 * back to file mtime when the dates tie.
 *
 * `updated` is day-granular (`YYYY-MM-DD`), so two edits on the same day always
 * fall through to mtime. Preferring the frontmatter date over mtime matters
 * because copying a vault between machines, restoring a backup, or a cloud
 * client rewriting timestamps all disturb mtime while leaving the note's own
 * record of when it was last meaningfully changed intact.
 */
export function pickConflictWinner(args: {
  localContent: string;
  localUpdated: number;
  remoteContent: string;
  remoteUpdated: number;
}): "local" | "remote" {
  const localDate = parseMemory(args.localContent).updated;
  const remoteDate = parseMemory(args.remoteContent).updated;
  if (localDate !== remoteDate)
    return localDate > remoteDate ? "local" : "remote";
  if (args.localUpdated !== args.remoteUpdated) {
    return args.localUpdated > args.remoteUpdated ? "local" : "remote";
  }
  // Identical dates and identical mtimes but differing content: prefer the
  // local copy so the pass is deterministic and does not depend on which
  // profile happened to run it.
  return "local";
}

export interface ReconcileArgs {
  local: LocalTreePort;
  transport: MemorySyncTransport;
  /** Baseline from the last successful sync for this profile. */
  baseline: Baseline;
  profile: SyncProfile;
  limits?: SyncLimits;
  now?: () => number;
}

export interface ReconcileOutcome {
  result: SyncResult;
  /** Baseline to persist. Only advanced for paths that actually converged. */
  baseline: Baseline;
}

/**
 * Run one sync pass.
 *
 * Idempotent: a second immediate run sees `local === remote === base` for every
 * path and performs no writes. That property, not the controller's re-entrancy
 * flag, is what guarantees sync cannot loop when its own writes emit
 * `vfs:change`.
 */
export async function reconcile(
  args: ReconcileArgs,
): Promise<ReconcileOutcome> {
  const limits = args.limits ?? DEFAULT_SYNC_LIMITS;
  const now = args.now ?? Date.now;
  const ranAt = now();
  const result = emptyResult(ranAt);
  const nextBaseline: Baseline = { ...args.baseline };

  const localEntries = await args.local.list();
  const remoteStats = await args.transport.listFiles();
  const tombstones = await args.transport.listTombstones();

  const localByPath = new Map(localEntries.map((e) => [e.path, e]));

  // Validate and bound the remote listing before reading a single byte. The
  // limits exist to stop a runaway or hostile vault, which they cannot do if the
  // whole tree has already been decoded in order to hash it.
  const accepted: RemoteFileStat[] = [];
  for (const stat of remoteStats) {
    const reason = classifyRemotePath(stat.path);
    if (reason) {
      result.skipped.push({ path: stat.path, reason });
      continue;
    }
    if (stat.size > limits.maxBytes) {
      result.skipped.push({ path: stat.path, reason: "too-large" });
      continue;
    }
    if (accepted.length >= limits.maxFiles) {
      result.skipped.push({ path: stat.path, reason: "too-many-files" });
      continue;
    }
    accepted.push(stat);
  }

  // Content is touched only now, for entries that survived the filter.
  const remoteByPath = new Map<string, { sha256: string; updated: number }>();
  for (const stat of accepted) {
    remoteByPath.set(stat.path, {
      sha256: await args.transport.hashFile(stat.path),
      updated: stat.updated,
    });
  }

  // Only tombstones for paths we would accept can act on us; ignore the rest so
  // a hostile vault cannot use a tombstone to reach outside the memory tree.
  const tombstoneByPath = new Map<string, Tombstone>();
  for (const t of tombstones) {
    if (classifyRemotePath(t.path)) continue;
    tombstoneByPath.set(t.path, t);
  }

  const paths = new Set<string>([
    ...localByPath.keys(),
    ...remoteByPath.keys(),
    ...tombstoneByPath.keys(),
    ...Object.keys(args.baseline),
  ]);

  for (const path of [...paths].sort()) {
    // A local path outside the syncable set (e.g. a space-scoped file that
    // somehow reached the local listing) is left strictly alone.
    if (classifyRemotePath(path)) continue;

    const localEntry = localByPath.get(path);
    const remoteEntry = remoteByPath.get(path);
    const base = args.baseline[path] ?? null;

    const decision = decide({
      local: localEntry?.sha256 ?? null,
      remote: remoteEntry?.sha256 ?? null,
      base,
      tombstoned: tombstoneByPath.has(path),
    });

    switch (decision.kind) {
      case "noop": {
        if (localEntry) nextBaseline[path] = localEntry.sha256;
        else delete nextBaseline[path];
        break;
      }

      case "push": {
        const content = await args.local.read(path);
        await args.transport.writeFile(path, content);
        // A push over a tombstone (vault lost the file without deleting it
        // through us) must clear the tombstone or the next pass would delete.
        if (tombstoneByPath.has(path)) {
          await args.transport.dropTombstone(path);
        }
        result.pushed.push(path);
        nextBaseline[path] = localEntry!.sha256;
        break;
      }

      case "pull": {
        const content = await args.transport.readFile(path);
        await args.local.write(path, content);
        result.pulled.push(path);
        nextBaseline[path] = remoteEntry!.sha256;
        break;
      }

      case "resurrect": {
        if (decision.direction === "push") {
          const content = await args.local.read(path);
          await args.transport.writeFile(path, content);
          await args.transport.dropTombstone(path);
          nextBaseline[path] = localEntry!.sha256;
        } else {
          const content = await args.transport.readFile(path);
          await args.local.write(path, content);
          nextBaseline[path] = remoteEntry!.sha256;
        }
        result.resurrected.push(path);
        break;
      }

      case "delete-local": {
        await args.local.remove(path);
        result.deletedLocal.push(path);
        delete nextBaseline[path];
        break;
      }

      case "delete-remote": {
        await args.transport.deleteFile(path);
        await args.transport.putTombstone({
          path,
          deletedAt: ranAt,
          profileId: args.profile.id,
          profileLabel: args.profile.label,
        });
        result.deletedRemote.push(path);
        delete nextBaseline[path];
        break;
      }

      case "conflict": {
        const localContent = await args.local.read(path);
        const remoteContent = await args.transport.readFile(path);
        const winner = pickConflictWinner({
          localContent,
          localUpdated: localEntry!.updated,
          remoteContent,
          remoteUpdated: remoteEntry!.updated,
        });

        if (winner === "local") {
          await args.transport.archiveConflict(path, remoteContent, ranAt);
          await args.transport.writeFile(path, localContent);
          nextBaseline[path] = localEntry!.sha256;
        } else {
          await args.transport.archiveConflict(path, localContent, ranAt);
          await args.local.write(path, remoteContent);
          nextBaseline[path] = remoteEntry!.sha256;
        }
        result.conflicts.push({
          path,
          winner,
          archivedAt: conflictArchivePath(path, ranAt),
        });
        break;
      }

      case "drop-baseline": {
        delete nextBaseline[path];
        break;
      }
    }
  }

  await gcTombstones(args.transport, tombstones, ranAt, limits);

  return { result, baseline: nextBaseline };
}

/** Vault-relative location a losing conflict copy is archived to. */
export function conflictArchivePath(path: string, at: number): string {
  return `.openbrowse/conflicts/${timestampSlug(at)}/${path}`;
}

/** `2026-09-07T14-22-01Z` — filename-safe and sorts chronologically. */
export function timestampSlug(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");
}

/**
 * Drop tombstones past their TTL. Retaining them forever would grow the vault
 * without bound; the cost of expiry is that a profile which has not synced in
 * over the TTL can resurrect a note deleted elsewhere, which the result reports
 * rather than hiding.
 */
async function gcTombstones(
  transport: MemorySyncTransport,
  tombstones: Tombstone[],
  ranAt: number,
  limits: SyncLimits,
): Promise<void> {
  for (const t of tombstones) {
    if (ranAt - t.deletedAt <= limits.tombstoneTtlMs) continue;
    try {
      await transport.dropTombstone(t.path);
    } catch {
      // Housekeeping only — never fail a sync over it.
    }
  }
}
