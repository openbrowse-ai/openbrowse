import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  ensurePersistedStorage,
  readStorageEstimate,
} from "../storage-persistence";

/**
 * Shape of the storage surface each context exposes. The MV3 service
 * worker is the interesting one: StorageManager.persist() is
 * [Exposed=Window] per the Storage Standard, so on WorkerNavigator the
 * property is simply absent. The module has to detect that rather than
 * calling a missing function.
 */
function stubStorage(storage: Record<string, unknown> | undefined) {
  vi.stubGlobal("navigator", storage === undefined ? {} : { storage });
}

const GIB = 1024 * 1024 * 1024;

beforeEach(() => {
  _resetForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensurePersistedStorage", () => {
  it("requests persistence and reports the grant", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 1 * GIB, quota: 40 * GIB }),
      persisted: vi.fn().mockResolvedValue(false),
      persist,
    });

    const res = await ensurePersistedStorage();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      persisted: true,
      requested: true,
      usage: 1 * GIB,
      quota: 40 * GIB,
    });
  });

  it("does not re-ask when the bucket is already persistent", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 1 * GIB, quota: 40 * GIB }),
      persisted: vi.fn().mockResolvedValue(true),
      persist,
    });

    const res = await ensurePersistedStorage();

    expect(persist).not.toHaveBeenCalled();
    expect(res.persisted).toBe(true);
    expect(res.requested).toBe(false);
  });

  it("no-ops in the service worker, where persist() is not exposed", async () => {
    // WorkerNavigator.storage has estimate + persisted but no persist.
    stubStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 1 * GIB, quota: 40 * GIB }),
      persisted: vi.fn().mockResolvedValue(false),
    });

    const res = await ensurePersistedStorage();

    expect(res.persisted).toBe(false);
    expect(res.requested).toBe(false);
  });

  it("swallows a rejecting persist() (opaque origin) instead of throwing", async () => {
    stubStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 1 * GIB, quota: 40 * GIB }),
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockRejectedValue(new TypeError("opaque origin")),
    });

    const res = await ensurePersistedStorage();

    expect(res).toMatchObject({ persisted: false, requested: true });
    expect(console.warn).toHaveBeenCalled();
  });

  it("memoizes, so concurrent surfaces share one request", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 1 * GIB, quota: 40 * GIB }),
      persisted: vi.fn().mockResolvedValue(false),
      persist,
    });

    const [a, b] = await Promise.all([
      ensurePersistedStorage(),
      ensurePersistedStorage(),
    ]);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("warns when quota headroom is nearly exhausted", async () => {
    // The early-warning signal for the exact condition that causes
    // whole-bucket eviction: a disk with almost nothing left.
    stubStorage({
      estimate: vi
        .fn()
        .mockResolvedValue({ usage: 40 * GIB, quota: 40 * GIB + 1024 }),
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
    });

    await ensurePersistedStorage();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("low headroom"),
    );
  });

  it("does not warn when there is plenty of headroom", async () => {
    stubStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 1 * GIB, quota: 40 * GIB }),
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true),
    });

    await ensurePersistedStorage();

    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("readStorageEstimate", () => {
  it("returns nulls rather than throwing when estimate() fails", async () => {
    stubStorage({ estimate: vi.fn().mockRejectedValue(new Error("nope")) });
    await expect(readStorageEstimate()).resolves.toEqual({
      usage: null,
      quota: null,
    });
  });

  it("returns nulls when the storage API is missing entirely", async () => {
    stubStorage(undefined);
    await expect(readStorageEstimate()).resolves.toEqual({
      usage: null,
      quota: null,
    });
  });
});
