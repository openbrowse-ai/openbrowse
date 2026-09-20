import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The controller is the wiring layer: settings, permission state, and mutual
// exclusion. It had no coverage at first, which let a syntax error survive a
// full green test run — nothing imported it. These tests exist so that class of
// mistake fails loudly.

const settingsStore: { value: Record<string, unknown> } = { value: {} };

vi.mock("@/lib/storage", () => ({
  storage: {
    getSettings: async () => ({ ...settingsStore.value }),
    updateSettings: async (
      updater: (c: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      settingsStore.value = updater({ ...settingsStore.value });
      return settingsStore.value;
    },
  },
}));

const handleStore: { handle: FileSystemDirectoryHandle | null } = { handle: null };
const baselineStore: { value: Record<string, Record<string, string>> } = {
  value: {},
};

vi.mock("../db", () => ({
  memorySyncDb: {
    getHandle: async () =>
      handleStore.handle
        ? { id: "vault", handle: handleStore.handle, name: "vault", linkedAt: 0 }
        : undefined,
    putHandle: async (h: FileSystemDirectoryHandle) => {
      handleStore.handle = h;
    },
    clearHandle: async () => {
      handleStore.handle = null;
    },
    getBaseline: async (id: string) => baselineStore.value[id] ?? {},
    putBaseline: async (id: string, b: Record<string, string>) => {
      baselineStore.value[id] = b;
    },
    clearBaseline: async (id: string) => {
      delete baselineStore.value[id];
    },
    _resetForTests: () => {},
  },
}));

const transportState = { status: "granted" as string };

vi.mock("../directory-transport", () => ({
  readStatus: async (handle: unknown) =>
    handle ? transportState.status : "unset",
  requestVaultPermission: async () => transportState.status,
  ensureVaultMeta: async () => ({
    vaultId: "vault-1",
    schemaVersion: 1,
    createdAt: 0,
  }),
  createDirectoryTransport: () => ({
    id: "fake",
    status: async () => transportState.status,
    listFiles: async () => [],
    readFile: async () => "",
    writeFile: async () => {},
    deleteFile: async () => {},
    listTombstones: async () => [],
    putTombstone: async () => {},
    dropTombstone: async () => {},
    archiveConflict: async () => {},
    listConflicts: async () => [],
    readConflict: async () => "",
    dropConflict: async () => {},
    withLock: async <T,>(fn: () => Promise<T>) => fn(),
  }),
}));

const hints: { published: unknown[]; cleared: string[]; suggestion: unknown } = {
  published: [],
  cleared: [],
  suggestion: null,
};

vi.mock("../discovery", () => ({
  publishVaultHint: async (h: unknown) => {
    hints.published.push(h);
  },
  clearVaultHint: async (id: string) => {
    hints.cleared.push(id);
  },
  readVaultSuggestion: async () => hints.suggestion,
  readOtherVaultHints: async () => (hints.suggestion ? [hints.suggestion] : []),
}));

const localList = vi.fn(async () => []);

/** Records the options `linkVault` passes to the picker. */
const pickerCalls: Array<Record<string, unknown>> = [];

vi.mock("../local-tree", () => ({
  createOpfsMemoryTree: () => ({
    list: localList,
    read: async () => "",
    write: async () => {},
    remove: async () => {},
  }),
}));

const fakeHandle = { name: "vault" } as unknown as FileSystemDirectoryHandle;

/** Backs the opportunistic floor, which lives in `chrome.storage.session`. */
let sessionStore: Record<string, unknown> = {};

beforeEach(() => {
  settingsStore.value = {};
  handleStore.handle = null;
  baselineStore.value = {};
  transportState.status = "granted";
  localList.mockClear();
  hints.published = [];
  hints.cleared = [];
  hints.suggestion = null;
  pickerCalls.length = 0;
  sessionStore = {};
  vi.stubGlobal("showDirectoryPicker", async (opts: Record<string, unknown>) => {
    pickerCalls.push(opts);
    return fakeHandle;
  });
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: async (key: string) =>
          key in sessionStore ? { [key]: sessionStore[key] } : {},
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        },
      },
    },
  });
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

/** Fresh module instance, so the module-level in-flight/self-writing state resets. */
async function loadController() {
  vi.resetModules();
  return import("../controller");
}

describe("getSyncSettings", () => {
  it("mints a profile id and persists it immediately", async () => {
    const { getSyncSettings } = await loadController();

    const first = await getSyncSettings();
    expect(first.profileId).toMatch(/[0-9a-f-]{36}/);
    expect(first.enabled).toBe(false);

    // A regenerated id would orphan this profile's tombstones, so it must be
    // stable from the very first read.
    const second = await getSyncSettings();
    expect(second.profileId).toBe(first.profileId);
  });
});

describe("getStatus", () => {
  it("is unset when sync was never enabled", async () => {
    const { getStatus } = await loadController();
    expect(await getStatus()).toBe("unset");
  });

  it("is unset when enabled but the handle is gone", async () => {
    const { getStatus, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    expect(await getStatus()).toBe("unset");
  });

  it("reflects the transport once a handle exists", async () => {
    const { getStatus, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    transportState.status = "lapsed";
    expect(await getStatus()).toBe("lapsed");
    transportState.status = "granted";
    expect(await getStatus()).toBe("granted");
  });
});

describe("syncNow", () => {
  it("does nothing when no vault is linked", async () => {
    const { syncNow } = await loadController();
    const result = await syncNow();
    expect(result.pulled).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(localList).not.toHaveBeenCalled();
  });

  it("skips silently on a lapsed grant when opportunistic", async () => {
    // Opportunistic passes must never surface an error the user didn't ask for —
    // a lapsed grant is the normal state at the start of a browser session.
    const { syncNow, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;
    transportState.status = "lapsed";

    const result = await syncNow({ opportunistic: true });

    expect(result.error).toBeUndefined();
    expect(localList).not.toHaveBeenCalled();
  });

  it("reports a lapsed grant when the user asked explicitly", async () => {
    const { syncNow, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;
    transportState.status = "lapsed";

    const result = await syncNow();

    expect(result.error).toMatch(/Reconnect the folder/);
  });

  it("runs a pass and records the result in settings", async () => {
    const { syncNow, getSyncSettings, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    const result = await syncNow();

    expect(result.error).toBeUndefined();
    expect(localList).toHaveBeenCalled();
    const settings = await getSyncSettings();
    expect(settings.lastSyncAt).toBe(result.ranAt);
    expect(settings.lastResult?.pulled).toBe(0);
  });

  it("coalesces concurrent calls into one pass", async () => {
    const { syncNow, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    const [a, b] = await Promise.all([syncNow(), syncNow()]);

    expect(a).toBe(b);
    expect(localList).toHaveBeenCalledTimes(1);
  });

  it("clears the self-writing flag even when a pass fails", async () => {
    // A stuck flag would permanently suppress the `vfs:change` trigger.
    const { syncNow, isSelfWriting, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;
    localList.mockRejectedValueOnce(new Error("disk on fire"));

    const result = await syncNow();

    expect(result.error).toBe("disk on fire");
    expect(isSelfWriting()).toBe(false);
  });
});

describe("unlinkVault", () => {
  it("forgets the vault without deleting anything", async () => {
    const { unlinkVault, getSyncSettings, patchSyncSettings } =
      await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;
    baselineStore.value["vault-1"] = { "memory/a.md": "hash" };

    await unlinkVault();

    const settings = await getSyncSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.vaultId).toBeNull();
    expect(handleStore.handle).toBeNull();
    expect(baselineStore.value["vault-1"]).toBeUndefined();
    // Leaving a hint behind would keep advertising a folder this profile no
    // longer uses.
    expect(hints.cleared).toEqual([settings.profileId]);
  });
});

describe("statusMessage", () => {
  it("phrases a lapsed grant as routine, not as a failure", async () => {
    const { statusMessage } = await loadController();
    expect(statusMessage("lapsed")).toBe(
      "Reconnect the folder to resume syncing.",
    );
    expect(statusMessage("granted")).toBe("");
    expect(statusMessage("missing")).toMatch(/moved or deleted/);
  });
});

describe("linkVault", () => {
  it("passes a picker id Chrome will accept, and starts in Documents", async () => {
    // The id must be ASCII alphanumeric or `_` and at most 32 chars — a hyphen
    // makes `showDirectoryPicker` throw TypeError, which would break the only
    // way into this feature.
    const { linkVault } = await loadController();

    await linkVault();

    expect(pickerCalls).toHaveLength(1);
    const id = pickerCalls[0].id as string;
    expect(id).toMatch(/^[A-Za-z0-9_]+$/);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(pickerCalls[0].startIn).toBe("documents");
    expect(pickerCalls[0].mode).toBe("readwrite");
  });

  it("advertises the linked vault to the user's other profiles", async () => {
    const { linkVault, getSyncSettings } = await loadController();

    await linkVault();

    const settings = await getSyncSettings();
    expect(hints.published).toEqual([
      {
        vaultId: "vault-1",
        folderName: "vault",
        profileId: settings.profileId,
        profileLabel: settings.profileLabel,
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("reports joining the folder another profile advertised", async () => {
    hints.suggestion = {
      vaultId: "vault-1",
      folderName: "OpenBrowse",
      profileId: "other",
      profileLabel: "Work",
      updatedAt: 1,
    };
    const { linkVault } = await loadController();

    expect((await linkVault()).joinedSuggestion).toBe("matched");
  });

  it("flags picking a different folder than the advertised one", async () => {
    // Silent divergence is the worst outcome here: both profiles look linked and
    // memory simply never converges.
    hints.suggestion = {
      vaultId: "some-other-vault",
      folderName: "Elsewhere",
      profileId: "other",
      profileLabel: "Work",
      updatedAt: 1,
    };
    const { linkVault } = await loadController();

    expect((await linkVault()).joinedSuggestion).toBe("mismatched");
  });

  it("reports no suggestion when nothing is advertised", async () => {
    const { linkVault } = await loadController();
    expect((await linkVault()).joinedSuggestion).toBe("none");
  });
});

describe("getVaultSuggestion", () => {
  it("offers another profile's vault while this one is unlinked", async () => {
    hints.suggestion = {
      vaultId: "vault-1",
      folderName: "OpenBrowse",
      profileId: "other",
      profileLabel: "Work",
      updatedAt: 1,
    };
    const { getVaultSuggestion } = await loadController();

    expect((await getVaultSuggestion())?.folderName).toBe("OpenBrowse");
  });

  it("stops offering once this profile is linked", async () => {
    hints.suggestion = {
      vaultId: "vault-1",
      folderName: "OpenBrowse",
      profileId: "other",
      profileLabel: "Work",
      updatedAt: 1,
    };
    const { getVaultSuggestion, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });

    expect(await getVaultSuggestion()).toBeNull();
  });
});

describe("shouldRunOpportunistic", () => {
  it("allows the first pass", async () => {
    const { shouldRunOpportunistic, OPPORTUNISTIC_FLOOR_MS } =
      await loadController();
    expect(shouldRunOpportunistic(null, 1_000, OPPORTUNISTIC_FLOOR_MS)).toBe(true);
  });

  it("suppresses a pass inside the floor and allows one after it", async () => {
    const { shouldRunOpportunistic } = await loadController();
    expect(shouldRunOpportunistic(1_000, 1_000 + 9_999, 10_000)).toBe(false);
    expect(shouldRunOpportunistic(1_000, 1_000 + 10_000, 10_000)).toBe(true);
  });

  it("recovers from a clock that moved backwards", async () => {
    // Sleep/wake and NTP corrections can leave a future timestamp behind; without
    // this sync would be locked out until real time caught up.
    const { shouldRunOpportunistic } = await loadController();
    expect(shouldRunOpportunistic(9_999_999, 1_000, 10_000)).toBe(true);
  });
});

describe("the opportunistic floor in syncNow", () => {
  it("runs the first opportunistic pass and skips an immediate second", async () => {
    // The driver is mounted in the side panel and in every home/new-tab page, so
    // tab switching would otherwise fire a pass per revealed tab.
    const { syncNow, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    await syncNow({ opportunistic: true });
    expect(localList).toHaveBeenCalledTimes(1);

    await syncNow({ opportunistic: true });
    expect(localList).toHaveBeenCalledTimes(1);
  });

  it("never throttles an explicit sync", async () => {
    const { syncNow, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    await syncNow({ opportunistic: true });
    await syncNow();
    await syncNow();

    expect(localList).toHaveBeenCalledTimes(3);
  });

  it("still syncs when session storage is unavailable", async () => {
    // Better to let the Web Lock serialize than to refuse to sync at all.
    const { syncNow, patchSyncSettings } = await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;
    vi.stubGlobal("chrome", {});

    await syncNow({ opportunistic: true });

    expect(localList).toHaveBeenCalledTimes(1);
  });
});

describe("the post-run trigger's floor", () => {
  it("is not suppressed by an unrelated pass moments earlier", async () => {
    // The whole point of the post-run trigger is that a run's memory reaches the
    // vault. A 10s floor would let a refocus pass 2s earlier swallow it.
    const { syncNow, patchSyncSettings, POST_RUN_FLOOR_MS } =
      await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    await syncNow({ opportunistic: true });
    expect(localList).toHaveBeenCalledTimes(1);

    // Simulate the earlier pass having happened a couple of seconds ago.
    sessionStore.memorySyncLastAttemptAt = Date.now() - 2_000;

    await syncNow({ opportunistic: true, floorMs: POST_RUN_FLOOR_MS });
    expect(localList).toHaveBeenCalledTimes(2);
  });

  it("still collapses the broadcast across several open surfaces", async () => {
    // Every mounted driver receives the same message; only the first should work.
    const { syncNow, patchSyncSettings, POST_RUN_FLOOR_MS } =
      await loadController();
    await patchSyncSettings({ enabled: true, vaultId: "vault-1" });
    handleStore.handle = fakeHandle;

    await syncNow({ opportunistic: true, floorMs: POST_RUN_FLOOR_MS });
    await syncNow({ opportunistic: true, floorMs: POST_RUN_FLOOR_MS });
    await syncNow({ opportunistic: true, floorMs: POST_RUN_FLOOR_MS });

    expect(localList).toHaveBeenCalledTimes(1);
  });
});
