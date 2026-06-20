/**
 * Effect-detection tests for clickElement's hit-target warning.
 *
 * The hit-test `hitWarning` (overlay-intercept) is a soft signal that
 * the click point landed on an element other than the target. Frequent
 * false positive on sites where the click hits a wrapper div or a
 * descendant span but the intended handler still fires. Plan C adds two
 * counter-signals: URL change + cdp-capture network activity. When
 * either fires, the warning is suppressed. When neither fires AND the
 * hit-test mismatched, the warning is augmented with a "no effect
 * detected" suffix so the agent treats it as actionable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { invalidateRefs, getRefsForTab } from "../../ref-store";
import { captureSnapshot } from "../../snapshot-capture";
import { clickElementTool } from "../click-element";
import {
  __test_pushNetwork,
  __test_reset as resetCapture,
  startCapture,
} from "../../cdp-capture";
import { __test_reset as resetSession } from "../../cdp-session";
import type { BrowserDriver, ToolContext } from "../../driver";
import { vi } from "vitest";

const TAB_ID = 1;
const URL = "https://example.com";

function onlyRef(tabId: number): string {
  const refs = getRefsForTab(tabId);
  expect(refs?.size).toBe(1);
  return [...(refs?.keys() ?? [])][0];
}

function buttonNode(extra: Record<string, unknown> = {}) {
  return {
    nodeId: "1",
    role: { value: "button" },
    name: { value: "OK" },
    backendDOMNodeId: 99,
    ...extra,
  };
}

function makeMockDriver(opts: {
  axTrees: Array<Array<unknown>>;
  url: string;
  /** URL returned by the post-click `getTab` — defaults to `url` (no nav). */
  postUrl?: string;
  hitBackendNodeId: number;
  describe?: { nodeName: string; attributes?: string[] };
}): BrowserDriver {
  let axIdx = 0;
  let getTabCalls = 0;
  return {
    sendCommand: async (
      _tabId: unknown,
      method: string,
    ): Promise<unknown> => {
      if (method === "Accessibility.getFullAXTree") {
        const nodes =
          opts.axTrees[Math.min(axIdx, opts.axTrees.length - 1)] ?? [];
        axIdx++;
        return { nodes };
      }
      if (method === "Target.getTargetInfo")
        return { targetInfo: { url: opts.url } };
      if (method === "DOM.getBoxModel")
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (method === "DOM.getNodeForLocation")
        return { backendNodeId: opts.hitBackendNodeId };
      if (method === "DOM.describeNode")
        return {
          node: {
            nodeName: opts.describe?.nodeName ?? "DIV",
            attributes: opts.describe?.attributes ?? [],
          },
        };
      if (method === "DOM.resolveNode")
        return { object: { objectId: "obj-1" } };
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { sx: 0, sy: 0, iw: 1280, ih: 800, vh: 800 },
          },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              vx: 0,
              vy: 0,
              vw: 10,
              vh: 10,
              sx: 0,
              sy: 0,
              iw: 1280,
              ih: 800,
            },
          },
        };
      }
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      return {};
    },
    getTab: async () => {
      // First call (resolveTabOrThrow) returns the pre-click URL.
      // Subsequent calls (post-click in clickElement) return postUrl.
      getTabCalls++;
      const url = getTabCalls === 1 ? opts.url : (opts.postUrl ?? opts.url);
      return { id: TAB_ID, url, title: "test" };
    },
    waitForLoad: async () => undefined,
    sendToContentScript: async () => ({ success: true }),
  } as unknown as BrowserDriver;
}

function makeCtx(driver: BrowserDriver): ToolContext {
  return {
    driver,
    session: { conversationId: null, resolveHandle: (_h: string) => TAB_ID },
  } as unknown as ToolContext;
}

beforeEach(() => {
  invalidateRefs(TAB_ID);
  resetCapture();
  resetSession();
  vi.restoreAllMocks();
});

describe("clickElement effect detection — URL signal", () => {
  it("suppresses the overlay warning when the click navigated", async () => {
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      postUrl: "https://example.com/landed",
      hitBackendNodeId: 1234, // mismatch — would normally warn
      describe: { nodeName: "DIV", attributes: ["class", "cookie-banner"] },
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    // URL changed → effect detected → warning suppressed entirely.
    expect(result.note ?? "").not.toMatch(/intercept|overlay/i);
    expect(result.note ?? "").not.toMatch(/no effect/i);
  });
});

describe("clickElement effect detection — network signal", () => {
  it("suppresses the overlay warning when network activity fired during/after the click", async () => {
    // Arm capture + push a request entry timestamped AFTER the click
    // dispatches. The clickElement code reads cdp-capture's buffer and
    // filters by `r.ts >= preTs`; we can't predict preTs exactly, but
    // pushing an entry timestamped at Date.now() inside the test (which
    // happens AFTER the tool reads preTs) is safe — we'll just push it
    // with a large `ts` to be unambiguous.
    //
    // To intercept the click flow at the right point, we use a spy that
    // pushes the entry when the click's post-action snapshot fires (via
    // an Accessibility.getFullAXTree call — the second one).
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 1234,
      describe: { nodeName: "DIV", attributes: ["class", "cookie-banner"] },
    });

    // Mark the tab as captured so readNetwork returns captured:true.
    // startCapture would normally do this via cdp-session.attach but
    // chrome.debugger.attach is a no-op test stub returning undefined,
    // so this works with the bare default mocks.
    await startCapture(TAB_ID);

    // Push a network entry timestamped Date.now() — happens AFTER the
    // click execute begins (preTs is taken at the very start of the
    // tool's body, before this test's continuation runs), so the
    // entry's ts >= preTs is true at read time.
    //
    // But wait: we need the entry visible BEFORE the tool reads the
    // buffer, which is post-snapshot. Push it now (synchronously)
    // before calling execute — preTs will be taken inside execute,
    // and our entry's ts will end up < preTs. Workaround: push with
    // a future timestamp.
    const futureTs = Date.now() + 10_000;
    __test_pushNetwork(TAB_ID, {
      requestId: "click-fired-this",
      url: "https://example.com/api/click-handler",
      method: "POST",
      resourceType: "Fetch",
      ts: futureTs,
    });

    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    // Network activity post-preTs → effect detected → warning suppressed.
    expect(result.note ?? "").not.toMatch(/intercept|overlay/i);
  });

  it("does NOT suppress the warning when only stale network activity exists (timestamps before preTs)", async () => {
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 1234,
      describe: { nodeName: "DIV", attributes: ["class", "modal-backdrop"] },
    });
    await startCapture(TAB_ID);
    // Push a request with a stale ts (well before now).
    __test_pushNetwork(TAB_ID, {
      requestId: "stale",
      url: "https://example.com/api/old",
      method: "GET",
      resourceType: "Fetch",
      ts: Date.now() - 60_000,
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    // Stale network → no effect signal → warning preserved with augmentation.
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/intercept|overlay/i);
    expect(result.note).toMatch(/no.*effect/i);
  });
});

describe("clickElement effect detection — augmentation", () => {
  it("appends the no-effect suffix when warning is kept (no nav, no network)", async () => {
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 1234,
      describe: { nodeName: "DIV", attributes: ["class", "cookie-banner"] },
    });
    // Capture not armed → readNetwork returns captured:false → networkActive=false.
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/intercept|overlay/i);
    // The augmentation tells the agent there's evidence of no effect.
    expect(result.note).toMatch(/No URL change or network activity/);
    expect(result.note).toMatch(/likely had no effect/);
  });

  it("does not augment when there's no warning to begin with (target was at click point)", async () => {
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99, // matches target — no warning
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.note ?? "").not.toMatch(/intercept|overlay/i);
    expect(result.note ?? "").not.toMatch(/no effect|likely had no effect/i);
  });
});
