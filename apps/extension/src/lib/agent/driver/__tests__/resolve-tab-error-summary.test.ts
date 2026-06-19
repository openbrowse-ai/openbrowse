/**
 * Tests for the inline-handle-summary enhancement to
 * `resolveTabIdOrThrow` / `resolveTabOrThrow`.
 *
 * Previously: when handle resolution failed, the error said "Call
 * listTabs to see available handles" — forcing the agent to make a
 * separate tool call to recover.
 *
 * Now: the error inlines the conversation's currently-bound handles
 * (with title + URL) so the agent can pick a replacement directly.
 * The summary is best-effort: handles whose ltid no longer resolves
 * to a live chrome tab are silently dropped, and a complete failure
 * of the helper falls back to the original (no-summary) wording.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveTabIdOrThrow,
  resolveTabOrThrow,
  ToolTabResolutionError,
  type ToolContext,
} from "../tool-context";
import { tabRegistry } from "../../tab-registry";
import {
  getOrCreateHandle,
  clearHandles,
  resolveHandle,
} from "../../tab-handles";

const CID = "conv-resolver-tests";

interface FakeTab {
  id: number;
  url: string;
  title: string;
}

/**
 * Stub chrome.tabs.get to return data for `tabsByCtid`. Unknown ctids
 * reject (mirrors Chrome's behavior on closed tabs) so the helper's
 * per-handle catch path is exercised.
 */
function stubChromeTabs(tabsByCtid: Map<number, FakeTab>): void {
  const fakeChrome = {
    ...(globalThis as { chrome: Record<string, unknown> }).chrome,
    tabs: {
      ...(globalThis as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs,
      get: vi.fn((id: number) => {
        const t = tabsByCtid.get(id);
        return t
          ? Promise.resolve(t)
          : Promise.reject(new Error(`No tab with id ${id}`));
      }),
    },
  };
  vi.stubGlobal("chrome", fakeChrome);
}

/** Bind a tab to the test conversation: registry → handle map. */
function bindHandle(ctid: number): string {
  const ltid = tabRegistry.registerExisting(ctid);
  return getOrCreateHandle(CID, ltid);
}

/**
 * Minimal ToolContext that points at the test conversation. The
 * session's `resolveHandle` reads from the same in-memory handle map
 * the conversation uses in production, so binding via `bindHandle`
 * makes the handle resolvable here.
 */
function makeCtx(): ToolContext {
  return {
    driver: {
      // Not exercised in resolveTabIdOrThrow tests; resolveTabOrThrow
      // tests stub via the chrome.tabs path.
      getTab: vi.fn(),
    } as unknown as ToolContext["driver"],
    session: {
      conversationId: CID,
      resolveHandle: (handle: string) => resolveHandle(CID, handle),
    },
  };
}

beforeEach(() => {
  clearHandles(CID);
});

afterEach(() => {
  clearHandles(CID);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveTabIdOrThrow — inline handle summary", () => {
  it("falls back to original wording when no handles are bound", async () => {
    stubChromeTabs(new Map());
    const ctx = makeCtx();
    await expect(async () => {
      await resolveTabIdOrThrow(ctx, "t99");
    }).rejects.toThrowError(ToolTabResolutionError);
    try {
      await resolveTabIdOrThrow(ctx, "t99");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Unknown tab handle "t99"/);
      // No "Currently bound" suffix because the conversation has none.
      expect(msg).not.toMatch(/Currently bound/);
      // Original recovery hint preserved.
      expect(msg).toMatch(/Call listTabs to see available handles/);
    }
  });

  it("inlines a single bound handle with title + URL", async () => {
    const handle = bindHandle(123);
    stubChromeTabs(
      new Map([
        [
          123,
          { id: 123, url: "https://example.com/page", title: "Example" },
        ],
      ]),
    );
    const ctx = makeCtx();
    try {
      await resolveTabIdOrThrow(ctx, "t-bogus");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Unknown tab handle "t-bogus"/);
      expect(msg).toMatch(/Currently bound:/);
      expect(msg).toContain(handle);
      expect(msg).toContain("Example");
      expect(msg).toContain("https://example.com/page");
    }
  });

  it("inlines multiple handles separated cleanly", async () => {
    const h1 = bindHandle(10);
    const h2 = bindHandle(20);
    const h3 = bindHandle(30);
    stubChromeTabs(
      new Map([
        [10, { id: 10, url: "https://a.test/", title: "A" }],
        [20, { id: 20, url: "https://b.test/", title: "B" }],
        [30, { id: 30, url: "https://c.test/", title: "C" }],
      ]),
    );
    const ctx = makeCtx();
    try {
      await resolveTabIdOrThrow(ctx, "tBOGUS");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      for (const h of [h1, h2, h3]) expect(msg).toContain(h);
      expect(msg).toContain("A");
      expect(msg).toContain("B");
      expect(msg).toContain("C");
    }
  });

  it("caps the summary at 5 entries and notes the overflow", async () => {
    const handles: string[] = [];
    const tabsByCtid = new Map<number, FakeTab>();
    for (let i = 0; i < 7; i++) {
      const ctid = 100 + i;
      handles.push(bindHandle(ctid));
      tabsByCtid.set(ctid, {
        id: ctid,
        url: `https://h${i}.test/`,
        title: `H${i}`,
      });
    }
    stubChromeTabs(tabsByCtid);
    const ctx = makeCtx();
    try {
      await resolveTabIdOrThrow(ctx, "tBOGUS");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      // Exactly 5 of the 7 titles should be present; the rest folded
      // into the overflow suffix.
      const titlesInMsg = ["H0", "H1", "H2", "H3", "H4", "H5", "H6"].filter(
        (t) => msg.includes(t),
      );
      expect(titlesInMsg.length).toBe(5);
      expect(msg).toMatch(/and 2 more/);
    }
  });

  it("drops handles whose ltid no longer resolves to a live ctid", async () => {
    const aliveHandle = bindHandle(200);
    // Register a second handle whose ctid won't be in chrome.tabs.get
    // — chrome.tabs.get rejects → helper drops just this entry.
    const deadHandle = bindHandle(201);
    stubChromeTabs(
      new Map([[200, { id: 200, url: "https://alive/", title: "Alive" }]]),
    );
    const ctx = makeCtx();
    try {
      await resolveTabIdOrThrow(ctx, "tBOGUS");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(aliveHandle);
      expect(msg).toContain("Alive");
      // Dead handle's title would be undefined; we deliberately don't
      // emit it. Only the alive handle survives.
      expect(msg).not.toContain(`${deadHandle} (`);
    }
  });

  it("preserves the ToolTabResolutionError type", async () => {
    bindHandle(300);
    stubChromeTabs(
      new Map([[300, { id: 300, url: "https://x/", title: "X" }]]),
    );
    const ctx = makeCtx();
    await expect(async () => {
      await resolveTabIdOrThrow(ctx, "tBOGUS");
    }).rejects.toBeInstanceOf(ToolTabResolutionError);
  });

  it("appends the same summary to the 'no longer points to an open tab' error", async () => {
    // Exercise the second throw branch in resolveTabIdOrThrow: the
    // session's handle map still resolves the handle to an ltid, but
    // the registry's ltid → ctid mapping is gone. In production this
    // happens in the window between Chrome firing onRemoved (which
    // calls tabRegistry.handleRemove → drops the mapping) and
    // tab-handles.dropLtid running, or after a service-worker restart
    // re-hydrates the handle map from chatDb before the registry has
    // re-registered the ltid for the (now possibly new) ctid.
    //
    // We reproduce this surgically with `tabRegistry.unregister(ltid)`:
    // the same public API tab-handles.dropLtid uses on tab close.
    // Bind a *second* live handle so the suffix has something to
    // emit — that proves the second throw site uses the same
    // recoverySuffix helper as the first.
    const staleLtid = tabRegistry.registerExisting(600);
    const staleHandle = getOrCreateHandle(CID, staleLtid);
    const liveHandle = bindHandle(700);
    stubChromeTabs(
      new Map([[700, { id: 700, url: "https://live/", title: "Live" }]]),
    );

    // Surgical break: the handle map still resolves staleHandle to
    // staleLtid, but the registry no longer knows what ctid that ltid
    // corresponds to. This is exactly the precondition for line 285
    // of tool-context.ts.
    tabRegistry.unregister(staleLtid);

    const ctx = makeCtx();
    try {
      await resolveTabIdOrThrow(ctx, staleHandle);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolTabResolutionError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/no longer points to an open tab/);
      // The OTHER (still-live) handle's summary should appear, proving
      // this throw site shares recoverySuffix with the others.
      expect(msg).toMatch(/Currently bound:/);
      expect(msg).toContain(liveHandle);
      expect(msg).toContain("Live");
    }
  });
});

describe("resolveTabOrThrow — inline handle summary", () => {
  it("inlines the summary when getTab fails (third throw site)", async () => {
    const handle = bindHandle(500);
    stubChromeTabs(
      new Map([
        [500, { id: 500, url: "https://t/", title: "Surviving Tab" }],
      ]),
    );
    const ctx = makeCtx();
    // Force the driver.getTab failure path: the handle resolves to
    // ctid=500 in the registry, but the driver throws when fetching
    // tab info for that ctid.
    (ctx.driver.getTab as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: number) => {
        if (id === 500) throw new Error("Tab no longer available");
        throw new Error("unexpected");
      },
    );
    try {
      await resolveTabOrThrow(ctx, handle);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/no longer available/);
      // The third throw site already mentioned listTabs; verify it
      // ALSO carries the inline summary now.
      expect(msg).toMatch(/Currently bound:/);
      expect(msg).toContain("Surviving Tab");
    }
  });
});
