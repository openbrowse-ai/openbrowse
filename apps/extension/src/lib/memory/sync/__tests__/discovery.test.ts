import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    clearVaultHint,
    publishVaultHint,
    readOtherVaultHints,
    readVaultSuggestion,
    type VaultHint,
} from "../discovery";

// Discovery rides `chrome.storage.sync`, which replicates through the user's
// Google account. Two properties matter: the payload stays minimal (a folder
// *name*, never a path, never note content), and every failure is silent —
// Chrome Sync being off must degrade to "no suggestion", not to a broken setup
// flow.

let store: Record<string, unknown>;
let failing: boolean;

function installChrome() {
  store = {};
  failing = false;
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: async (keys: string | string[] | null) => {
          if (failing) throw new Error("sync unavailable");
          if (keys === null) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            list.filter((k) => k in store).map((k) => [k, store[k]]),
          );
        },
        set: async (items: Record<string, unknown>) => {
          if (failing) throw new Error("quota exceeded");
          Object.assign(store, items);
        },
        remove: async (key: string) => {
          if (failing) throw new Error("sync unavailable");
          delete store[key];
        },
      },
    },
  });
}

function hint(overrides: Partial<VaultHint> = {}): VaultHint {
  return {
    vaultId: "vault-1",
    folderName: "OpenBrowse",
    profileId: "profile-a",
    profileLabel: "Work",
    updatedAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  installChrome();
});

// Matches the neighbouring suites. Vitest isolates per file today, so leaving the
// `chrome` stub in place is currently harmless — but it would leak the moment
// isolation were turned off for speed.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishVaultHint", () => {
  it("stores the hint under a per-profile key", async () => {
    await publishVaultHint(hint());
    expect(store).toEqual({ "memorySyncHint:profile-a": hint() });
  });

  it("carries a folder name but never a path or note content", async () => {
    // This payload leaves the machine via Chrome Sync, so its shape is a
    // privacy decision, not an implementation detail.
    await publishVaultHint(hint());
    const stored = store["memorySyncHint:profile-a"] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "folderName",
      "profileId",
      "profileLabel",
      "updatedAt",
      "vaultId",
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/\//);
  });

  it("stays well under Chrome's 8 KB per-item cap", async () => {
    await publishVaultHint(hint({ folderName: "A".repeat(120) }));
    const bytes = new TextEncoder().encode(
      JSON.stringify(store["memorySyncHint:profile-a"]),
    ).length;
    expect(bytes).toBeLessThan(1_000);
  });

  it("is silent when Chrome Sync is unavailable", async () => {
    failing = true;
    await expect(publishVaultHint(hint())).resolves.toBeUndefined();
  });

  it("does not throw when `chrome.storage.sync` is missing entirely", async () => {
    vi.stubGlobal("chrome", {});
    await expect(publishVaultHint(hint())).resolves.toBeUndefined();
  });
});

describe("readOtherVaultHints", () => {
  it("excludes this profile's own hint", async () => {
    await publishVaultHint(hint({ profileId: "profile-a" }));
    await publishVaultHint(hint({ profileId: "profile-b", profileLabel: "Personal" }));

    const hints = await readOtherVaultHints("profile-a");

    expect(hints.map((h) => h.profileId)).toEqual(["profile-b"]);
  });

  it("returns the newest first", async () => {
    await publishVaultHint(hint({ profileId: "old", updatedAt: 1 }));
    await publishVaultHint(hint({ profileId: "new", updatedAt: 99 }));

    expect((await readOtherVaultHints("me")).map((h) => h.profileId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("ignores unrelated sync keys and malformed hints", async () => {
    store["someOtherFeature"] = { hello: "world" };
    store["memorySyncHint:broken"] = { folderName: "no vault id" };
    store["memorySyncHint:alsoBroken"] = null;
    await publishVaultHint(hint({ profileId: "good" }));

    expect((await readOtherVaultHints("me")).map((h) => h.profileId)).toEqual([
      "good",
    ]);
  });

  it("returns nothing rather than throwing when sync fails", async () => {
    failing = true;
    expect(await readOtherVaultHints("me")).toEqual([]);
  });
});

describe("readVaultSuggestion", () => {
  it("is null with no other profile linked", async () => {
    await publishVaultHint(hint({ profileId: "me" }));
    expect(await readVaultSuggestion("me")).toBeNull();
  });

  it("returns the most recent other profile's vault", async () => {
    await publishVaultHint(hint({ profileId: "other", updatedAt: 5 }));
    const suggestion = await readVaultSuggestion("me");
    expect(suggestion?.folderName).toBe("OpenBrowse");
    expect(suggestion?.profileLabel).toBe("Work");
  });
});

describe("clearVaultHint", () => {
  it("withdraws only this profile's hint", async () => {
    await publishVaultHint(hint({ profileId: "profile-a" }));
    await publishVaultHint(hint({ profileId: "profile-b" }));

    await clearVaultHint("profile-a");

    expect(Object.keys(store)).toEqual(["memorySyncHint:profile-b"]);
  });

  it("is silent when sync is unavailable", async () => {
    failing = true;
    await expect(clearVaultHint("profile-a")).resolves.toBeUndefined();
  });
});
