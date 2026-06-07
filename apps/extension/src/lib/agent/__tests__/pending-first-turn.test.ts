import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markPendingFirstTurn,
  hasPendingFirstTurn,
  clearPendingFirstTurn,
} from "../pending-first-turn";

describe("pending-first-turn", () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (k: string) =>
            k in store ? { [k]: store[k] } : {},
          ),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (k: string) => {
            delete store[k];
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is not pending by default", async () => {
    expect(await hasPendingFirstTurn("conv-1")).toBe(false);
  });

  it("marks then reports pending", async () => {
    await markPendingFirstTurn("conv-1");
    expect(await hasPendingFirstTurn("conv-1")).toBe(true);
  });

  it("scopes the marker per conversation", async () => {
    await markPendingFirstTurn("conv-1");
    expect(await hasPendingFirstTurn("conv-1")).toBe(true);
    expect(await hasPendingFirstTurn("conv-2")).toBe(false);
  });

  it("clears the marker", async () => {
    await markPendingFirstTurn("conv-1");
    await clearPendingFirstTurn("conv-1");
    expect(await hasPendingFirstTurn("conv-1")).toBe(false);
  });

  it("does not throw when session storage is unavailable", async () => {
    vi.stubGlobal("chrome", {});
    await expect(markPendingFirstTurn("conv-1")).resolves.toBeUndefined();
    await expect(hasPendingFirstTurn("conv-1")).resolves.toBe(false);
    await expect(clearPendingFirstTurn("conv-1")).resolves.toBeUndefined();
  });

  it("ignores ids with unsafe characters or bad length (no storage write, reads false)", async () => {
    const setSpy = chrome.storage.session.set as ReturnType<typeof vi.fn>;
    for (const bad of ["a/b", "a b", "a.b", "x".repeat(200), "", "a:b"]) {
      await markPendingFirstTurn(bad);
      expect(await hasPendingFirstTurn(bad)).toBe(false);
      await clearPendingFirstTurn(bad);
    }
    // No write ever reached storage for unsafe ids.
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("treats a prefixed __proto__ id as a harmless namespaced key (no pollution)", async () => {
    // `__proto__` matches the url-safe allowlist, but the KEY_PREFIX means
    // the stored key is `pending-first-turn:__proto__`, which cannot pollute
    // Object.prototype. The marker still round-trips like any other id.
    await markPendingFirstTurn("__proto__");
    expect(await hasPendingFirstTurn("__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("accepts uuid-shaped ids", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    await markPendingFirstTurn(id);
    expect(await hasPendingFirstTurn(id)).toBe(true);
  });
});
