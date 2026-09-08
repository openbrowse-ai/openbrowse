// src/lib/memory/sync/hash.ts
//
// SHA-256 over file contents, for the sync manifest and baseline.
//
// `contentHash` in `../format.ts` is 32-bit FNV-1a. That is the right tool for
// detecting staleness between an OPFS file and its own index row, but it is too
// weak to arbitrate writes arriving from another Chrome profile: sync compares
// hashes to decide what to overwrite and what to delete, so a collision is a
// silent data-loss bug rather than a stale-cache nuisance. Sync therefore uses
// SHA-256 (available via `crypto.subtle` in both extension pages and the
// service worker) and leaves `contentHash` untouched.

const encoder = new TextEncoder();

/** SHA-256 hex digest of `content` encoded as UTF-8. */
export async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(content));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Byte length of `content` as UTF-8 — the size that matters for limits. */
export function byteLength(content: string): number {
  return encoder.encode(content).length;
}
