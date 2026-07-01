import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("oauth/refresh-tokens", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-rt-"));
    vi.stubEnv("HOME", tmpHome);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T00:00:00Z"));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("issues and redeems a refresh token, rotating to a new one", async () => {
    const { createRefreshTokenStore } = await import("../refresh-tokens");
    const store = await createRefreshTokenStore();
    const t1 = store.issue({ clientId: "c1", scope: "task" });
    const result = store.redeem(t1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.clientId).toBe("c1");
      expect(result.newToken).not.toBe(t1);
    }
    // Old token rejected on second redeem
    expect(store.redeem(t1).ok).toBe(false);
  });

  it("rejects expired (>30 day) refresh tokens", async () => {
    const { createRefreshTokenStore } = await import("../refresh-tokens");
    const store = await createRefreshTokenStore();
    const t = store.issue({ clientId: "c1", scope: "task" });
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    const result = store.redeem(t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("revoke clears all tokens for a client", async () => {
    const { createRefreshTokenStore } = await import("../refresh-tokens");
    const store = await createRefreshTokenStore();
    const t = store.issue({ clientId: "c1", scope: "task" });
    await store.revokeClient("c1");
    expect(store.redeem(t).ok).toBe(false);
  });

  it("persists across reload", async () => {
    const { createRefreshTokenStore } = await import("../refresh-tokens");
    const s1 = await createRefreshTokenStore();
    const t = s1.issue({ clientId: "c1", scope: "task" });
    vi.resetModules();
    const { createRefreshTokenStore: cr2 } = await import("../refresh-tokens");
    const s2 = await cr2();
    expect(s2.redeem(t).ok).toBe(true);
  });

  it("preserves issuedAt across rotation so the 30-day absolute TTL holds", async () => {
    const { createRefreshTokenStore } = await import("../refresh-tokens");
    const store = await createRefreshTokenStore();
    const originalIssuedAt = Date.now();
    const t1 = store.issue({ clientId: "c1", scope: "task" });
    vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000); // 15 days
    const r = store.redeem(t1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // After rotation, the new entry's issuedAt is unchanged from the original.
    expect(r.entry.issuedAt).toBe(originalIssuedAt);
    // Advance another 16 days (total 31 from original issuedAt) — should expire.
    vi.advanceTimersByTime(16 * 24 * 60 * 60 * 1000);
    const r2 = store.redeem(r.newToken);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("expired");
  });
});
