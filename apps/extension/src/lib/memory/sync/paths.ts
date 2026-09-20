// src/lib/memory/sync/paths.ts
//
// Path validation for files arriving from the vault.
//
// This is a real trust boundary: until sync, every memory file in OPFS was
// authored by the extension itself. A vault is a user-chosen directory that may
// be shared, cloud-synced, or checked into a repo, so its contents are
// untrusted input and every path must be validated before it is used to write
// into OPFS.
//
// `parseMemoryPath` alone is not sufficient. It accepts `memory/../evil.md`
// (`relPath` is simply `../evil.md`), because inside the extension it only ever
// receives paths the extension constructed. Segment-level checks close that.

import { parseMemoryPath } from "../format";
import type { SkipReason } from "./types";

/** Longest path we will accept, to bound pathological input. */
const MAX_PATH_LENGTH = 512;

/**
 * Whether every segment of `path` is a plain, non-traversing name. Rejects
 * absolute paths, empty/`.`/`..` segments, backslashes (Windows separators that
 * would be a single legal OPFS filename), dotfiles, control characters, and
 * anything over the length cap.
 */
export function isSafeRelPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith("/")) return false;
  // A backslash or NUL anywhere means the producer disagrees with us about what
  // a separator is; refuse rather than guess.
  if (path.includes("\\") || path.includes("\u0000")) return false;

  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment) return false;
    if (segment === "." || segment === "..") return false;
    // Dotfiles are how sync metadata hides itself (`.openbrowse/`); a memory
    // file must never be one, so this doubles as metadata exclusion.
    if (segment.startsWith(".")) return false;
    // Control characters (including a stray CR from a text-mode transfer).
    if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
  }
  return true;
}

/**
 * Decide whether a vault path may be written into OPFS. Returns `null` when the
 * path is acceptable, or the reason to skip it.
 *
 * v1 syncs global memory only: a space-scoped path is refused because
 * `Space.id` is a per-profile UUID and would be meaningless here.
 */
export function classifyRemotePath(path: string): SkipReason | null {
  if (!isSafeRelPath(path)) return "unsafe-path";
  const info = parseMemoryPath(path);
  if (!info) return "not-global-memory";
  if (info.spaceId !== null) return "not-global-memory";
  return null;
}

/** Whether a local OPFS path is in scope for v1 sync (global memory markdown). */
export function isSyncableLocalPath(path: string): boolean {
  return classifyRemotePath(path) === null;
}
