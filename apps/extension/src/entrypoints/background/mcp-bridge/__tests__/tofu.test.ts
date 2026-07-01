import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcp-bridge/tofu", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete store[key];
          }),
        },
      },
    };
    (globalThis as any).__store = store;
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).__store;
    vi.resetModules();
  });

  it("getTrustedFingerprint returns null when none stored", async () => {
    const { getTrustedFingerprint } = await import("../tofu");
    expect(await getTrustedFingerprint()).toBeNull();
  });

  it("trustBroker stores the fingerprint", async () => {
    const { trustBroker, getTrustedFingerprint } = await import("../tofu");
    await trustBroker({
      fingerprint: "abc123",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    expect(await getTrustedFingerprint()).toBe("abc123");
  });

  it("isTrustedBroker returns true for matching fingerprint", async () => {
    const { trustBroker, isTrustedBroker } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp1",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    expect(await isTrustedBroker("fp1")).toBe(true);
    expect(await isTrustedBroker("different")).toBe(false);
  });

  it("clearTrust removes the stored fingerprint", async () => {
    const { trustBroker, clearTrust, getTrustedFingerprint } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp1",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    await clearTrust();
    expect(await getTrustedFingerprint()).toBeNull();
  });
});
