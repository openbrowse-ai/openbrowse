import { describe, expect, it, vi } from "vitest";
import {
  buildTabLegendEntries,
  isInternalChromeUrl,
  renderTabLegend,
} from "../tab-legend";

const CONV = "conv-x";

function fakeGetOrCreateHandle(_convId: string, tabId: number): string {
  return `t${tabId}`;
}

describe("isInternalChromeUrl", () => {
  it("classifies extension and chrome URLs as internal", () => {
    expect(isInternalChromeUrl("chrome://settings")).toBe(true);
    expect(isInternalChromeUrl("chrome-extension://abc/popup.html")).toBe(true);
    expect(isInternalChromeUrl("devtools://devtools/x")).toBe(true);
  });

  it("classifies http/https URLs as not internal", () => {
    expect(isInternalChromeUrl("https://example.com")).toBe(false);
    expect(isInternalChromeUrl("http://localhost:3000")).toBe(false);
  });

  it("treats undefined/empty as not internal (so a fetch failure doesn't auto-drop)", () => {
    expect(isInternalChromeUrl(undefined)).toBe(false);
    expect(isInternalChromeUrl("")).toBe(false);
  });
});

describe("buildTabLegendEntries", () => {
  it("returns one entry per live, non-internal tab", async () => {
    const getTab = vi.fn(async (tabId: number) => ({
      url: `https://example.com/${tabId}`,
      title: `Tab ${tabId}`,
    }));
    const entries = await buildTabLegendEntries({
      conversationId: CONV,
      ownedTabIds: [1, 2, 3],
      getTab,
      getOrCreateHandle: fakeGetOrCreateHandle,
      activeTabId: null,
    });
    expect(entries).toEqual([
      { handle: "t1", url: "https://example.com/1", title: "Tab 1", active: false },
      { handle: "t2", url: "https://example.com/2", title: "Tab 2", active: false },
      { handle: "t3", url: "https://example.com/3", title: "Tab 3", active: false },
    ]);
  });

  it("marks the active tab", async () => {
    const getTab = async (tabId: number) => ({
      url: `https://example.com/${tabId}`,
      title: `Tab ${tabId}`,
    });
    const entries = await buildTabLegendEntries({
      conversationId: CONV,
      ownedTabIds: [10, 20],
      getTab,
      getOrCreateHandle: fakeGetOrCreateHandle,
      activeTabId: 20,
    });
    expect(entries[0].active).toBe(false);
    expect(entries[1].active).toBe(true);
  });

  it("drops tabs whose getTab() rejects (closed tab)", async () => {
    const getTab = async (tabId: number) => {
      if (tabId === 99) throw new Error("No tab with id 99");
      return { url: `https://example.com/${tabId}`, title: `Tab ${tabId}` };
    };
    const entries = await buildTabLegendEntries({
      conversationId: CONV,
      ownedTabIds: [1, 99, 2],
      getTab,
      getOrCreateHandle: fakeGetOrCreateHandle,
      activeTabId: null,
    });
    expect(entries.map((e) => e.handle)).toEqual(["t1", "t2"]);
  });

  it("drops tabs that landed on a chrome-extension:// URL", async () => {
    const getTab = async (tabId: number) => {
      if (tabId === 5) {
        return {
          url: "chrome-extension://abc/something.html",
          title: "Extension page",
        };
      }
      return { url: `https://example.com/${tabId}`, title: `Tab ${tabId}` };
    };
    const entries = await buildTabLegendEntries({
      conversationId: CONV,
      ownedTabIds: [1, 5, 2],
      getTab,
      getOrCreateHandle: fakeGetOrCreateHandle,
      activeTabId: null,
    });
    expect(entries.map((e) => e.handle)).toEqual(["t1", "t2"]);
  });

  it("falls back to '(untitled)' when title is empty", async () => {
    const getTab = async (_tabId: number) => ({
      url: "https://example.com/foo",
      title: "  ",
    });
    const entries = await buildTabLegendEntries({
      conversationId: CONV,
      ownedTabIds: [1],
      getTab,
      getOrCreateHandle: fakeGetOrCreateHandle,
      activeTabId: null,
    });
    expect(entries[0].title).toBe("(untitled)");
  });

  it("returns [] when ownedTabIds is empty", async () => {
    const entries = await buildTabLegendEntries({
      conversationId: CONV,
      ownedTabIds: [],
      getTab: async () => ({ url: "x", title: "x" }),
      getOrCreateHandle: fakeGetOrCreateHandle,
      activeTabId: null,
    });
    expect(entries).toEqual([]);
  });
});

describe("renderTabLegend", () => {
  it("emits a clear bootstrap hint when there are no entries", () => {
    const out = renderTabLegend([]);
    expect(out).toContain("## Tabs in this conversation");
    expect(out).toContain("No tabs bound to this conversation yet");
    expect(out).toContain("navigate({ url })");
  });

  it("formats each entry on its own line with handle, title, and url", () => {
    const out = renderTabLegend([
      {
        handle: "t1",
        url: "https://amazon.com/dp/X",
        title: "Amazon — X",
        active: false,
      },
      {
        handle: "t2",
        url: "https://github.com/o/r",
        title: "GitHub - o/r",
        active: true,
      },
    ]);
    expect(out).toContain("- t1: Amazon — X — https://amazon.com/dp/X");
    expect(out).toContain("- t2: GitHub - o/r — https://github.com/o/r  [active]");
    // Should mention how to use it
    expect(out).toContain("Pass one of these handles");
  });
});
