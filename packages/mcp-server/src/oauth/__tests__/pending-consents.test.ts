import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("oauth/pending-consents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T00:00:00Z"));
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a pending consent and retrieves it by state", async () => {
    const { createPendingConsents } = await import("../pending-consents");
    const pc = createPendingConsents();
    const handle = pc.create({
      client_id: "c1",
      redirect_uri: "u",
      scope: "task",
      code_challenge: "ch",
      code_challenge_method: "S256",
      resource: "r",
      state: "s1",
    });
    expect(handle.state).toBe("s1");
    expect(pc.find("s1")?.client_id).toBe("c1");
  });

  it("removes consents after grant", async () => {
    const { createPendingConsents } = await import("../pending-consents");
    const pc = createPendingConsents();
    pc.create({
      client_id: "c1", redirect_uri: "u", scope: "s",
      code_challenge: "ch", code_challenge_method: "S256",
      resource: "r", state: "s1",
    });
    expect(pc.find("s1")).toBeDefined();
    pc.consume("s1");
    expect(pc.find("s1")).toBeUndefined();
  });

  it("expires consents after 5 minutes via sweep()", async () => {
    const { createPendingConsents } = await import("../pending-consents");
    const pc = createPendingConsents();
    pc.create({
      client_id: "c1", redirect_uri: "u", scope: "s",
      code_challenge: "ch", code_challenge_method: "S256",
      resource: "r", state: "s1",
    });
    vi.advanceTimersByTime(301_000);
    pc.sweep();
    expect(pc.find("s1")).toBeUndefined();
  });
});
