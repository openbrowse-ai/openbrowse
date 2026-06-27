import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setPendingFixRequest,
  takePendingFixRequest,
  FIX_REQUEST_TTL_MS,
  type ArtifactFixRequest,
} from "../pending-fix-request";

function req(overrides: Partial<ArtifactFixRequest> = {}): ArtifactFixRequest {
  return {
    artifactId: "linear-triage",
    prompt: "fix it",
    autoSubmit: true,
    requestedAt: 1000,
    ...overrides,
  };
}

describe("pending-fix-request", () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
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

  afterEach(() => vi.unstubAllGlobals());

  it("returns null when nothing is queued", async () => {
    expect(await takePendingFixRequest()).toBeNull();
  });

  it("returns and clears a queued request", async () => {
    await setPendingFixRequest(req());
    expect(await takePendingFixRequest(1000)).toEqual(req());
    expect(await takePendingFixRequest(1000)).toBeNull();
  });

  it("latest request wins", async () => {
    await setPendingFixRequest(req({ prompt: "first" }));
    await setPendingFixRequest(req({ prompt: "second" }));
    expect((await takePendingFixRequest(1000))?.prompt).toBe("second");
  });

  it("discards a stale request past the TTL", async () => {
    await setPendingFixRequest(req({ requestedAt: 0 }));
    expect(await takePendingFixRequest(FIX_REQUEST_TTL_MS + 1)).toBeNull();
  });

  it("returns a request within the TTL", async () => {
    await setPendingFixRequest(req({ requestedAt: 0 }));
    expect(await takePendingFixRequest(FIX_REQUEST_TTL_MS)).not.toBeNull();
  });
});
