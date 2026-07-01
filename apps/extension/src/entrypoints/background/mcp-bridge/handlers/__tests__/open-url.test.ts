import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  (globalThis as any).chrome = {
    windows: {
      getCurrent: vi.fn(async () => ({ id: 1, focused: true })),
      get: vi.fn(async (id: number) => ({ id, focused: false })),
    },
    tabs: {
      create: vi.fn(async (opts: { windowId: number; url: string; active?: boolean }) => ({
        id: 999, windowId: opts.windowId, url: opts.url, active: !!opts.active,
      })),
    },
  };
});
afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/open_url", () => {
  it("opens a URL in the focused window as an inactive tab by default", async () => {
    const { handleOpenUrl } = await import("../open-url");
    const result = await handleOpenUrl(
      { url: "https://example.com" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.tabId).toBe(999);
    expect(result.windowId).toBe(1);
    expect((globalThis as any).chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 1, url: "https://example.com", active: false }),
    );
  });

  it("accepts an explicit windowId", async () => {
    const { handleOpenUrl } = await import("../open-url");
    const result = await handleOpenUrl(
      { url: "https://example.com", windowId: 5 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.windowId).toBe(5);
  });

  it("makes the new tab active when requested", async () => {
    const { handleOpenUrl } = await import("../open-url");
    await handleOpenUrl(
      { url: "https://example.com", active: true },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect((globalThis as any).chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
  });

  it("rejects missing url", async () => {
    const { handleOpenUrl } = await import("../open-url");
    await expect(
      handleOpenUrl({}, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("rejects non-http(s) urls", async () => {
    const { handleOpenUrl } = await import("../open-url");
    await expect(
      handleOpenUrl(
        { url: "javascript:alert(1)" },
        { authContext: { sub: "c1" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid_url" });
    await expect(
      handleOpenUrl({ url: "file:///etc/passwd" }, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_url" });
  });
});
