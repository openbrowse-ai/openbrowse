import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent/snapshot-capture", () => ({
  captureSnapshot: vi.fn(async (_driver: unknown, _tabId: number, _opts: unknown) => ({
    snapshotText: `@e1 [heading] "Hello"`,
    refs: { e1: { id: "e1", role: "heading" } },
    previous: null,
    signals: [],
    previousSignals: [],
    belowFoldCount: 0,
    note: "",
  })),
}));

// Also mock the ExtensionDriver — we don't need real CDP for unit tests.
vi.mock("@/lib/agent/driver/extension-driver", () => ({
  ExtensionDriver: class {
    // No-op driver stub; captureSnapshot is mocked above so it never reads from this.
  },
}));

beforeEach(() => {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: "https://a.com", title: "Title" })),
      query: vi.fn(async () => [{ id: 100, url: "https://a.com", title: "Title" }]),
      sendMessage: vi.fn(async (_tabId: number, msg: { type: string }) => {
        if (msg.type === "CHAT_EXTRACT_CONTENT") {
          return { url: "https://a.com", title: "Title", h1: "Hello", bodyText: "body", links: [], description: null };
        }
        throw new Error("unknown message");
      }),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: 1, focused: true })),
    },
  };
});
afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/read-page", () => {
  it("returns a snapshot by default", async () => {
    const { handleReadPage } = await import("../read-page");
    const result = await handleReadPage({ tabId: 100 });
    expect(result.format).toBe("snapshot");
    expect(result.content).toContain("@e1");
    expect(result.url).toBe("https://a.com");
    expect(result.title).toBe("Title");
  });

  it("returns text format when requested", async () => {
    const { handleReadPage } = await import("../read-page");
    const result = await handleReadPage({ tabId: 100, format: "text" });
    expect(result.format).toBe("text");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("body");
  });

  it("resolves active tab when tabId omitted", async () => {
    const { handleReadPage } = await import("../read-page");
    const result = await handleReadPage({});
    expect(result.url).toBe("https://a.com");
  });

  it("errors when tabId does not exist", async () => {
    (globalThis as any).chrome.tabs.get = vi.fn(async () => {
      throw new Error("no such tab");
    });
    const { handleReadPage } = await import("../read-page");
    await expect(handleReadPage({ tabId: 9999 })).rejects.toThrow(/tab_not_found/);
  });
});
