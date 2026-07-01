import { describe, expect, it, vi } from "vitest";
import {
  buildHomeTabQuery,
  buildOpenConversationHash,
  buildOpenConversationUrl,
  findTabIdMatchingConversation,
  openOrFocusConversation,
} from "../open-conversation";

/**
 * The home-tab deep-link helpers used by RecentTaskRow (completed
 * task rows) AND ActiveTaskCard (running task rows). Tests live here
 * so both call sites share a single source of truth and a single test
 * surface.
 */

describe("open-conversation — buildOpenConversationHash", () => {
  it("prefixes the conversation id with #", () => {
    expect(buildOpenConversationHash("conv-abc")).toBe("#conv-abc");
  });

  it("does not escape characters in the id (ids are already URL-safe)", () => {
    expect(buildOpenConversationHash("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      "#01234567-89ab-cdef-0123-456789abcdef",
    );
  });
});

describe("open-conversation — buildOpenConversationUrl", () => {
  it("composes a chrome.runtime.getURL home.html URL with the conversation hash", () => {
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
    });
    expect(buildOpenConversationUrl("conv-abc")).toBe(
      "chrome-extension://test/home.html#conv-abc",
    );
    vi.unstubAllGlobals();
  });
});

describe("open-conversation — buildHomeTabQuery", () => {
  it("returns a wildcard url matcher for the home.html path", () => {
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
    });
    expect(buildHomeTabQuery()).toEqual({
      url: "chrome-extension://test/home.html*",
    });
    vi.unstubAllGlobals();
  });
});

describe("open-conversation — findTabIdMatchingConversation", () => {
  it("returns the id of the tab whose hash matches", () => {
    expect(
      findTabIdMatchingConversation(
        [
          { id: 1, url: "chrome-extension://test/home.html#conv-1" },
          { id: 2, url: "chrome-extension://test/home.html#conv-2" },
          { id: 3, url: "chrome-extension://test/home.html#conv-3" },
        ],
        "conv-2",
      ),
    ).toBe(2);
  });

  it("returns null when no tab matches", () => {
    expect(
      findTabIdMatchingConversation(
        [{ id: 1, url: "chrome-extension://test/home.html#conv-1" }],
        "conv-missing",
      ),
    ).toBeNull();
  });

  it("skips tabs with no id (race during tab creation)", () => {
    expect(
      findTabIdMatchingConversation(
        [
          { url: "chrome-extension://test/home.html#conv-1" },
          { id: 2, url: "chrome-extension://test/home.html#conv-1" },
        ],
        "conv-1",
      ),
    ).toBe(2);
  });

  it("skips tabs with no url (about:blank race)", () => {
    expect(
      findTabIdMatchingConversation([{ id: 1 }], "conv-1"),
    ).toBeNull();
  });

  it("matches only on an exact hash suffix (not a substring)", () => {
    // A conv-id is a prefix of another; only the exact match wins.
    expect(
      findTabIdMatchingConversation(
        [
          { id: 1, url: "chrome-extension://test/home.html#conv-1-not-the-one" },
          { id: 2, url: "chrome-extension://test/home.html#conv-1" },
        ],
        "conv-1",
      ),
    ).toBe(2);
  });

  it("returns the FIRST match when there are duplicates", () => {
    expect(
      findTabIdMatchingConversation(
        [
          { id: 5, url: "chrome-extension://test/home.html#conv-1" },
          { id: 6, url: "chrome-extension://test/home.html#conv-1" },
        ],
        "conv-1",
      ),
    ).toBe(5);
  });
});

describe("open-conversation — openOrFocusConversation", () => {
  function stubChrome(opts: {
    tabsForQuery?: { id?: number; url?: string }[];
    updateReturnsWindow?: number;
    createSpy?: ReturnType<typeof vi.fn>;
    updateSpy?: ReturnType<typeof vi.fn>;
    windowsUpdateSpy?: ReturnType<typeof vi.fn>;
  }) {
    const create =
      opts.createSpy ??
      vi.fn(async (_args: unknown) => ({ id: 999 }));
    const update =
      opts.updateSpy ??
      vi.fn(async (_id: number, _props: unknown) => ({
        id: 1,
        windowId: opts.updateReturnsWindow ?? 100,
      }));
    const windowsUpdate =
      opts.windowsUpdateSpy ??
      vi.fn(async (_winId: number, _props: unknown) => undefined);
    vi.stubGlobal("chrome", {
      runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
      tabs: {
        query: vi.fn(async () => opts.tabsForQuery ?? []),
        create,
        update,
      },
      windows: { update: windowsUpdate },
    });
    return { create, update, windowsUpdate };
  }

  it("focuses an existing tab when one already points at the conversation", async () => {
    const { create, update, windowsUpdate } = stubChrome({
      tabsForQuery: [
        { id: 42, url: "chrome-extension://test/home.html#conv-1" },
      ],
    });
    await openOrFocusConversation("conv-1");
    expect(update).toHaveBeenCalledWith(42, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(100, { focused: true });
    expect(create).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("creates a new tab when no existing tab matches", async () => {
    const { create, update } = stubChrome({
      tabsForQuery: [
        { id: 1, url: "chrome-extension://test/home.html#different-conv" },
      ],
    });
    await openOrFocusConversation("conv-new");
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://test/home.html#conv-new",
      active: true,
    });
    expect(update).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("falls back to window.open when chrome.tabs APIs throw", async () => {
    const winOpen = vi.fn();
    vi.stubGlobal("window", { open: winOpen });
    vi.stubGlobal("chrome", {
      runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
      tabs: {
        query: vi.fn(async () => {
          throw new Error("nope");
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
      windows: { update: vi.fn() },
    });
    await openOrFocusConversation("conv-fallback");
    expect(winOpen).toHaveBeenCalledWith(
      "chrome-extension://test/home.html#conv-fallback",
      "_blank",
    );
    vi.unstubAllGlobals();
  });
});
