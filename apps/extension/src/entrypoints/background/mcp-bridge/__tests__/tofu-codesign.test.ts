import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("tofu binarySha256", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: store[k] })),
          set: vi.fn(async (o: Record<string, unknown>) => {
            Object.assign(store, o);
          }),
          remove: vi.fn(async (k: string) => {
            delete store[k];
          }),
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    vi.resetModules();
  });

  it("trustBroker stores binarySha256 when provided", async () => {
    const { trustBroker, getTrustRecord } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp1",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
      binarySha256: "abc123",
    });
    const r = await getTrustRecord();
    expect(r?.binarySha256).toBe("abc123");
  });

  it("backwards compatible: trust record without binarySha256 stays valid", async () => {
    const { trustBroker, getTrustRecord } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp1",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    const r = await getTrustRecord();
    expect(r?.fingerprint).toBe("fp1");
    expect(r?.binarySha256).toBeUndefined();
  });

  it("trustBroker omits binarySha256 when not provided (no `undefined` written to storage)", async () => {
    const { trustBroker, getTrustRecord } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp2",
      processInfo: { pid: 2, executablePath: "/y", startedAt: 0 },
    });
    const r = await getTrustRecord();
    // Use 'in' rather than `=== undefined` so we catch the case where
    // serialization happens to round-trip an undefined field.
    expect(r && "binarySha256" in r ? r.binarySha256 : "missing").toBe("missing");
  });
});
