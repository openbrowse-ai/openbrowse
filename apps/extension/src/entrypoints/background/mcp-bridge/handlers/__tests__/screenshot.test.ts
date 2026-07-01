import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `captureScreenshot` returns a raw base64 PNG string (no `data:` prefix) —
// see apps/extension/src/lib/agent/capture-utils.ts. The mock mirrors that.
vi.mock("@/lib/agent/capture-utils", () => ({
  captureScreenshot: vi.fn(
    async (_driver: unknown, tabId: number, _params: unknown) =>
      Buffer.from([0x89, 0x50, 0x4e, 0x47, tabId & 0xff]).toString("base64"),
  ),
}));

vi.mock("@/lib/agent/driver/extension-driver", () => ({
  ExtensionDriver: class {},
}));

beforeEach(() => {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: "https://a.com", title: "A" })),
      query: vi.fn(async () => [{ id: 200, active: true, url: "https://focused.com" }]),
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 1, focused: true })) },
    runtime: { getManifest: () => ({ version: "0.0.0" }) },
  };
});
afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/screenshot", () => {
  it("captures a PNG screenshot and returns it as an artifact payload", async () => {
    const { handleScreenshot } = await import("../screenshot");
    const result = await handleScreenshot(
      { tabId: 42 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.contentType).toBe("image/png");
    expect(result.filename).toMatch(/screenshot.*\.png$/);
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
  });

  it("rejects when tabId is omitted and no focused tab exists", async () => {
    (globalThis as any).chrome.windows.getCurrent = vi.fn(async () => ({ id: undefined }));
    const { handleScreenshot } = await import("../screenshot");
    await expect(
      handleScreenshot({}, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "no_focused_window" });
  });

  it("falls back to active tab in focused window when tabId omitted", async () => {
    const { handleScreenshot } = await import("../screenshot");
    const result = await handleScreenshot(
      {},
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    // The active-tab fallback uses tabs.query result (id: 200)
    expect(result.filename).toContain("200");
  });
});
