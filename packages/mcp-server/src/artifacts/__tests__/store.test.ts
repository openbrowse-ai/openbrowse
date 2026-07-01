import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("artifacts/store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves an artifact", async () => {
    const { createArtifactStore } = await import("../store");
    const store = createArtifactStore();
    const id = store.put({
      ownerClientId: "c1",
      contentType: "image/png",
      bytes: Buffer.from("hello"),
      filename: "page.png",
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(16);

    const got = store.get(id);
    expect(got?.bytes.toString()).toBe("hello");
    expect(got?.contentType).toBe("image/png");
    expect(got?.ownerClientId).toBe("c1");
  });

  it("rejects artifacts over the 25 MiB cap", async () => {
    const { createArtifactStore } = await import("../store");
    const store = createArtifactStore();
    const tooBig = Buffer.alloc(26 * 1024 * 1024);
    expect(() =>
      store.put({ ownerClientId: "c1", contentType: "application/octet-stream", bytes: tooBig }),
    ).toThrow(/too large/);
  });

  it("expires artifacts after 24 hours via sweep()", async () => {
    const { createArtifactStore } = await import("../store");
    const store = createArtifactStore();
    const id = store.put({ ownerClientId: "c1", contentType: "text/plain", bytes: Buffer.from("hi") });
    expect(store.get(id)).toBeDefined();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    store.sweep();
    expect(store.get(id)).toBeUndefined();
  });

  it("returns undefined for unknown ids", async () => {
    const { createArtifactStore } = await import("../store");
    const store = createArtifactStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });
});
