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

const localList = vi.fn(async () => []);

vi.mock("../local-tree", () => ({
  createOpfsMemoryTree: () => ({
    list: localList,
    read: async () => "",
    write: async () => {},
    remove: async () => {},
  }),
}));

const fakeHandle = { name: "vault" } as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
  settingsStore.value = {};
  handleStore.handle = null;
  baselineStore.value = {};
  transportState.status = "granted";
  localList.mockClear();
});

afterEach(() => {
  vi.resetModules();
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
