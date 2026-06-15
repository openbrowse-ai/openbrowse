import { beforeEach, describe, expect, it } from "vitest";
import { invalidateRefs, getRefsForTab } from "../../ref-store";
import { captureSnapshot } from "../../snapshot-capture";
import { clickElementTool } from "../click-element";
import type { BrowserDriver, ToolContext } from "../../driver";

const TAB_ID = 1;
const URL = "https://example.com";

/** Resolve the tab's single interactive ref (content-hash id, not @e1). */
function onlyRef(tabId: number): string {
  const refs = getRefsForTab(tabId);
  expect(refs?.size).toBe(1);
  return [...(refs?.keys() ?? [])][0];
}

function makeMockDriver(opts: {
  axTrees: Array<Array<unknown>>;
  url: string;
  hitBackendNodeId: number;
  describe?: { nodeName: string; attributes?: string[] };
  /** Box model content quad in DOCUMENT coordinates — exactly what
   *  `DOM.getBoxModel` returns. Defaults to a 10x10 box at origin. */
  boxContent?: number[];
  /** Live viewport metrics returned by `Runtime.evaluate` (legacy path) /
   *  `Runtime.callFunctionOn` (atomic path). */
  viewport?: { sx: number; sy: number; iw: number; ih: number };
  /** Capture every CDP call into this array (used by the new tests). */
  callLog?: Array<[string, Record<string, unknown> | undefined]>;
  /** Capture every sendToContentScript message into this array. */
  csLog?: Array<Record<string, unknown>>;
  /** When true, `Runtime.callFunctionOn` throws — exercises the
   *  `boxmodel-fallback` coord path that reads scroll/viewport via a
   *  separate `Runtime.evaluate` instead. */
  failCallFunctionOn?: boolean;
}): BrowserDriver {
  let axIdx = 0;
  return {
    sendCommand: async (
      _tabId: unknown,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (opts.callLog) opts.callLog.push([method, params]);
      if (method === "Accessibility.getFullAXTree") {
        const nodes = opts.axTrees[Math.min(axIdx, opts.axTrees.length - 1)] ?? [];
        axIdx++;
        return { nodes };
      }
      if (method === "Target.getTargetInfo") return { targetInfo: { url: opts.url } };
      if (method === "DOM.getBoxModel")
        return {
          model: {
            content: opts.boxContent ?? [0, 0, 10, 0, 10, 10, 0, 10],
          },
        };
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
        // Routed through Runtime.evaluate from three readers:
        //   - waitForLayoutFlush (viewport.ts) — awaits a rAF promise.
        //   - readViewportMetrics (viewport.ts) — reads { sx, sy, iw, ih }.
        //   - getViewportInfo (snapshot-capture.ts) — reads { sy, vh }.
        // We return a superset so any reader picks up its fields. `vh`
        // mirrors `ih` so test-controlled `viewport.ih` flows to the
        // post-action snapshot's below-fold computation too.
        const v = opts.viewport ?? { sx: 0, sy: 0, iw: 1280, ih: 800 };
        return { result: { value: { ...v, vh: v.ih } } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (opts.failCallFunctionOn) {
          throw new Error("callFunctionOn unavailable in test");
        }
        // Atomic geometry read: derive viewport rect from boxContent − scroll.
        const v = opts.viewport ?? { sx: 0, sy: 0, iw: 1280, ih: 800 };
        const c = opts.boxContent ?? [0, 0, 10, 0, 10, 10, 0, 10];
        const docX = (c[0] + c[2] + c[4] + c[6]) / 4;
        const docY = (c[1] + c[3] + c[5] + c[7]) / 4;
        const w = Math.max(c[2], c[4]) - Math.min(c[0], c[6]);
        const h = Math.max(c[5], c[7]) - Math.min(c[1], c[3]);
        return {
          result: {
            value: {
              vx: docX - v.sx - w / 2,
              vy: docY - v.sy - h / 2,
              vw: w,
              vh: h,
              sx: v.sx,
              sy: v.sy,
              iw: v.iw,
              ih: v.ih,
            },
          },
        };
      }
      // DOM.scrollIntoViewIfNeeded — return a non-null result so the call is
      // counted as success (the helper only catches throws).
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      return {};
    },
    getTab: async () => ({ id: TAB_ID, url: opts.url, title: "test" }),
    waitForLoad: async () => undefined,
    sendToContentScript: async (
      _tabId: unknown,
      message: Record<string, unknown>,
    ) => {
      if (opts.csLog) opts.csLog.push(message);
      return { success: true };
    },
  } as unknown as BrowserDriver;
}

function makeCtx(driver: BrowserDriver): ToolContext {
  return {
    driver,
    session: { conversationId: null, resolveHandle: (_h: string) => TAB_ID },
  } as unknown as ToolContext;
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

beforeEach(() => invalidateRefs(TAB_ID));

describe("clickByRef hit-target verification", () => {
  it("does NOT warn when the target itself is at the click point", async () => {
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99, // same as target
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.note ?? "").not.toMatch(/intercept|overlay/i);
  });

  it("warns (but still clicks) when a different element is at the click point", async () => {
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 1234, // an overlay, not the target
      describe: { nodeName: "DIV", attributes: ["class", "cookie-banner"] },
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/intercept|overlay/i);
    expect(result.note).toContain("cookie-banner");
  });
});

describe("clickByRef viewport coordinate conversion", () => {
  it("subtracts scroll offset from box-model document coords before dispatching mouse events", async () => {
    // Element at document coords (500, 6300)..(600, 6320). Page is scrolled
    // to (0, 5800), so the element's VIEWPORT coords are (500..600, 500..520).
    // Center should be (550, 510) in viewport space — NOT (550, 6310) which
    // would be off-screen and silently no-op the click.
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
      boxContent: [500, 6300, 600, 6300, 600, 6320, 500, 6320],
      viewport: { sx: 0, sy: 5800, iw: 1280, ih: 800 },
      callLog: calls,
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.note ?? "").not.toMatch(/outside the visible viewport/);

    const mouseCalls = calls.filter(([m]) => m === "Input.dispatchMouseEvent");
    // mouseMoved + mousePressed + mouseReleased
    expect(mouseCalls).toHaveLength(3);
    for (const [, params] of mouseCalls) {
      expect(params?.x).toBe(550);
      expect(params?.y).toBe(510);
    }
  });

  it("calls DOM.scrollIntoViewIfNeeded before reading the final box model", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
      callLog: calls,
    });
    await captureSnapshot(driver, TAB_ID);

    await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    const scrollIdx = calls.findIndex(
      ([m]) => m === "DOM.scrollIntoViewIfNeeded",
    );
    expect(scrollIdx).toBeGreaterThanOrEqual(0);
    // The post-scroll getBoxModel re-read happens AFTER the scroll call — and
    // before any Input.dispatchMouseEvent.
    const boxIdxAfterScroll = calls.findIndex(
      ([m], i) => i > scrollIdx && m === "DOM.getBoxModel",
    );
    const firstMouseIdx = calls.findIndex(
      ([m]) => m === "Input.dispatchMouseEvent",
    );
    expect(boxIdxAfterScroll).toBeGreaterThan(scrollIdx);
    expect(firstMouseIdx).toBeGreaterThan(boxIdxAfterScroll);
  });

  it("warns when the element remains outside the viewport even after scrollIntoViewIfNeeded", async () => {
    // Box at document-y 10000, viewport scroll-y 0, viewport height 800 →
    // viewport-y 10000, which is outside [0, 800]. scrollIntoViewIfNeeded
    // is mocked as a no-op so the post-scroll re-read returns the same box.
    // The tool should still dispatch (so we never silently swallow an
    // attempted click) but attach a clear off-viewport warning.
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
      boxContent: [500, 10000, 600, 10000, 600, 10020, 500, 10020],
      viewport: { sx: 0, sy: 0, iw: 1280, ih: 800 },
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/outside the visible viewport/);
  });
});

describe("clickByRef visual ripple", () => {
  it("emits a CHAT_CUA_CLICK_RIPPLE message at the dispatch coords (parity with the CUA loop's click animation)", async () => {
    // Same coord setup as the viewport-conversion test: element at doc
    // (500..600, 6300..6320), scrolled to sy=5800 → viewport-center (550, 510).
    // After dispatch, the tool should send a ripple at exactly (550, 510)
    // so a human watching the live tab sees the same animation the CUA
    // subagent emits.
    const csMessages: Array<Record<string, unknown>> = [];
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
      boxContent: [500, 6300, 600, 6300, 600, 6320, 500, 6320],
      viewport: { sx: 0, sy: 5800, iw: 1280, ih: 800 },
      csLog: csMessages,
    });
    await captureSnapshot(driver, TAB_ID);

    await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );
    // The ripple is fire-and-forget — let the void promise resolve.
    await new Promise((r) => setTimeout(r, 0));

    const ripples = csMessages.filter(
      (m) => m.type === "CHAT_CUA_CLICK_RIPPLE",
    );
    expect(ripples).toHaveLength(1);
    expect(ripples[0]).toMatchObject({
      type: "CHAT_CUA_CLICK_RIPPLE",
      x: 550,
      y: 510,
    });
  });

  it("does not block or fail the click if the ripple message dispatch throws", async () => {
    // Override sendToContentScript to throw on the ripple. Click must still
    // succeed — the ripple is purely a visual flourish.
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
    });
    // Replace sendToContentScript with one that throws on ripple but returns
    // success on every other content-script call (passthrough toggles, etc.).
    (driver as { sendToContentScript: unknown }).sendToContentScript = async (
      _tabId: unknown,
      message: Record<string, unknown>,
    ) => {
      if (message.type === "CHAT_CUA_CLICK_RIPPLE") {
        throw new Error("no content script");
      }
      return { success: true };
    };
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );
    expect(result.clicked).toBe(true);
  });
});

describe("clickByRef boxmodel-fallback coord path (gBCR unavailable)", () => {
  it("uses live readViewportMetrics for scroll/viewport when Runtime.callFunctionOn fails", async () => {
    // The bug this regresses: when the atomic gBCR read throws (detached
    // objectId, debugger doesn't support callFunctionOn), the fallback used
    // to compute coords as `postDocX - postGeom.scrollX`, but
    // postGeom.scrollX is the zero-sentinel from readElementGeometry's
    // empty result on failure. Result: clicks dispatched at DOCUMENT coords
    // and silently missed any element below scroll(0,0). The fix reads
    // scroll/viewport via a separate Runtime.evaluate when in fallback.
    //
    // Element at document (500..600, 6300..6320). Page scrolled to sy=5800.
    // Correct viewport-center: (550, 510). Wrong (pre-fix) coord: (550, 6310).
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
      boxContent: [500, 6300, 600, 6300, 600, 6320, 500, 6320],
      viewport: { sx: 0, sy: 5800, iw: 1280, ih: 800 },
      callLog: calls,
      failCallFunctionOn: true,
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );
    expect(result.clicked).toBe(true);
    // Must NOT report off-viewport — coords were correct, just via fallback.
    expect(result.note ?? "").not.toMatch(/outside the visible viewport/);

    const mouseCalls = calls.filter(([m]) => m === "Input.dispatchMouseEvent");
    expect(mouseCalls).toHaveLength(3);
    for (const [, params] of mouseCalls) {
      expect(params?.x).toBe(550); // viewport-center X
      expect(params?.y).toBe(510); // viewport-center Y (NOT 6310 — that's docY)
    }
  });

  it("flags off-viewport correctly in fallback when readViewportMetrics shows the element below the fold", async () => {
    // gBCR fails AND the element is way below the viewport. We must still
    // surface the off-viewport warning — pre-fix, innerW/H came from
    // postGeom (zero in the empty-result), so the guard's `innerW > 0`
    // check was false and the warning never fired.
    const tree = [buttonNode()];
    const driver = makeMockDriver({
      axTrees: [tree, tree],
      url: URL,
      hitBackendNodeId: 99,
      boxContent: [500, 10000, 600, 10000, 600, 10020, 500, 10020],
      viewport: { sx: 0, sy: 0, iw: 1280, ih: 800 },
      failCallFunctionOn: true,
    });
    await captureSnapshot(driver, TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: onlyRef(TAB_ID) },
      makeCtx(driver),
    );
    expect(result.clicked).toBe(true);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/outside the visible viewport/);
  });
});