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
});
