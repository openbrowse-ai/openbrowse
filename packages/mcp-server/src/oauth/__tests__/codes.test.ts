import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("oauth/codes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T00:00:00Z"));
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a code that can be redeemed once with matching params", async () => {
    const { createCodeStore } = await import("../codes");
    const store = createCodeStore();
    const code = store.issue({
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:9999/cb",
      scope: "task",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: "http://localhost:47821/mcp",
      state: "s1",
    });
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(16);

    const redeemed = store.redeem(code, {
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:9999/cb",
    });
    expect(redeemed.ok).toBe(true);
    if (redeemed.ok) {
      expect(redeemed.entry.scope).toBe("task");
    }
  });

  it("returns code_not_found for unknown codes", async () => {
    const { createCodeStore } = await import("../codes");
    const store = createCodeStore();
    const res = store.redeem("nonexistent", { client_id: "c1", redirect_uri: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("code_not_found");
  });

  it("returns already_used after first successful redeem", async () => {
    const { createCodeStore } = await import("../codes");
    const store = createCodeStore();
    const code = store.issue({
      client_id: "c1", redirect_uri: "u", scope: "s",
      code_challenge: "ch", code_challenge_method: "S256",
      resource: "r", state: "st",
    });
    store.redeem(code, { client_id: "c1", redirect_uri: "u" });
    const second = store.redeem(code, { client_id: "c1", redirect_uri: "u" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_used");
  });

  it("returns expired after 5 minutes", async () => {
    const { createCodeStore } = await import("../codes");
    const store = createCodeStore();
    const code = store.issue({
      client_id: "c1", redirect_uri: "u", scope: "s",
      code_challenge: "ch", code_challenge_method: "S256",
      resource: "r", state: "st",
    });
    vi.advanceTimersByTime(301_000);  // 5 minutes + 1s
    const res = store.redeem(code, { client_id: "c1", redirect_uri: "u" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("returns client_id_mismatch when client_id differs", async () => {
    const { createCodeStore } = await import("../codes");
    const store = createCodeStore();
    const code = store.issue({
      client_id: "c1", redirect_uri: "u", scope: "s",
      code_challenge: "ch", code_challenge_method: "S256",
      resource: "r", state: "st",
    });
    const res = store.redeem(code, { client_id: "c2", redirect_uri: "u" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("client_id_mismatch");
  });

  it("returns redirect_uri_mismatch when redirect_uri differs", async () => {
    const { createCodeStore } = await import("../codes");
    const store = createCodeStore();
    const code = store.issue({
      client_id: "c1", redirect_uri: "u", scope: "s",
      code_challenge: "ch", code_challenge_method: "S256",
      resource: "r", state: "st",
    });
    const res = store.redeem(code, { client_id: "c1", redirect_uri: "u-different" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("redirect_uri_mismatch");
  });
});
