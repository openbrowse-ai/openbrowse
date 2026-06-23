import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHomePage } from "../scheduled-run";

describe("ensureHomePage — only adopts home.html, never newtab.html", () => {
  let createdUrls: string[];
  let queriedPatterns: string[];
  let tabsToReturn: { url: string }[];

  beforeEach(() => {
    createdUrls = [];
    queriedPatterns = [];
    tabsToReturn = [];

    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (p: string) => `chrome-extension://test${p}`,
      },
      tabs: {
        query: (q: { url: string }) => {
          queriedPatterns.push(q.url);
          return Promise.resolve(tabsToReturn);
        },
        create: (opts: { url: string; pinned: boolean; active: boolean }) => {
          createdUrls.push(opts.url);
          return Promise.resolve({ id: 99 });
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries for /home.html, not newtab.html", async () => {
    await ensureHomePage();
    expect(queriedPatterns).toEqual([
      "chrome-extension://test/home.html*",
    ]);
  });

  it("opens a new home.html tab when none exists, even if a newtab.html tab is open", async () => {
    // Simulate: an open newtab tab is NOT returned by a /home.html* query.
    // Chrome's tab.query is URL-pattern based and would not match newtab.html
    // for a /home.html* pattern, so the production query already filters
    // newtabs out. Mock returns [] to model that.
    tabsToReturn = [];
    await ensureHomePage();
    expect(createdUrls).toEqual(["chrome-extension://test/home.html"]);
  });

  it("reuses an existing home.html tab and does not open a new one", async () => {
    tabsToReturn = [{ url: "chrome-extension://test/home.html" }];
    await ensureHomePage();
    expect(createdUrls).toEqual([]);
  });
});
