// src/lib/memory/sync/discovery.ts
//
// Cross-profile vault discovery over `chrome.storage.sync`.
//
// The hardest step in setting up sync is not clicking "Choose folder" — it is
// knowing *which* folder to choose in the second profile. Chrome deliberately
// won't let an extension preselect a path, and the picker's remembered directory
// is per-profile, so profile B gets no help from profile A.
//
// `chrome.storage.sync` can't hold a `FileSystemDirectoryHandle` (it is
// JSON-only), but it can hold a tiny *hint*: this vault's random id, the folder's
// name, and which profile linked it. That is enough for an unlinked profile to
// say "your Work profile syncs to a folder named OpenBrowse — pick that one" and,
// afterwards, to verify the user picked the same vault rather than a different
// folder that happens to be lying around.
//
// Deliberately minimal payload. `chrome.storage.sync` replicates through the
// user's Google account when Chrome Sync is on, so anything written here leaves
// the machine. A folder *name* and a user-chosen label do; an absolute path never
// does, and no memory content ever does.
//
// Everything here is best-effort. Chrome Sync may be off, the quota may be full,
// or the profiles may be signed into different accounts — in which case there are
// simply no hints and the folder flow works exactly as it did before.

const HINT_PREFIX = "memorySyncHint:";

/** Chrome's per-item cap is 8 KB; a hint is ~150 bytes. */
export interface VaultHint {
  /** The vault's own id, from `.openbrowse/vault.json`. */
  vaultId: string;
  /** Folder name only — never a path. */
  folderName: string;
  /** Which profile published this. */
  profileId: string;
  /** That profile's label, e.g. "Work". May be empty. */
  profileLabel: string;
  updatedAt: number;
}

function keyFor(profileId: string): string {
  return `${HINT_PREFIX}${profileId}`;
}

function isHint(value: unknown): value is VaultHint {
  const h = value as Partial<VaultHint> | null;
  return (
    !!h &&
    typeof h.vaultId === "string" &&
    !!h.vaultId &&
    typeof h.folderName === "string" &&
    typeof h.profileId === "string" &&
    !!h.profileId
  );
}

/**
 * Announce this profile's vault so the user's other profiles can point at the
 * same folder. Silently does nothing when Chrome Sync is unavailable.
 */
export async function publishVaultHint(hint: VaultHint): Promise<void> {
  try {
    await chrome.storage.sync.set({ [keyFor(hint.profileId)]: hint });
  } catch {
    // Sync disabled, quota exceeded, or no `storage.sync` in this context. The
    // folder flow does not depend on this succeeding.
  }
}

/** Withdraw this profile's hint. Called on unlink. */
export async function clearVaultHint(profileId: string): Promise<void> {
  try {
    await chrome.storage.sync.remove(keyFor(profileId));
  } catch {
    // Best-effort; a stale hint is harmless — it only ever suggests a folder.
  }
}

/**
 * Hints published by the user's *other* profiles, newest first.
 *
 * Seeing a hint here is also proof that the profiles share a Google account with
 * Chrome Sync on, which is otherwise not detectable — worth knowing, because it
 * is the precondition for offering an account-based transport later.
 */
export async function readOtherVaultHints(
  ownProfileId: string,
): Promise<VaultHint[]> {
  try {
    const all = await chrome.storage.sync.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(HINT_PREFIX))
      .map(([, value]) => value)
      .filter(isHint)
      .filter((h) => h.profileId !== ownProfileId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

/** The most recently linked vault from another profile, if any. */
export async function readVaultSuggestion(
  ownProfileId: string,
): Promise<VaultHint | null> {
  const hints = await readOtherVaultHints(ownProfileId);
  return hints[0] ?? null;
}
