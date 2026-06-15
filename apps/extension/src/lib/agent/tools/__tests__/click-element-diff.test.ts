import { beforeEach, describe, expect, it } from "vitest";
import { invalidateRefs, getRefsForTab } from "../../ref-store";
import { captureSnapshot } from "../../snapshot-capture";
import { clickElementTool } from "../click-element";
import type { BrowserDriver, ToolContext } from "../../driver";

const TAB_ID = 1;
const URL = "https://example.com";

/**
 * Returns the single stable ref assigned to a tab's only interactive element.
 * Refs are content-hash ids now (not ordinal @e1), so tests resolve them
 * dynamically rather than hardcoding.
 */
function onlyRef(tabId: number): string {
  const refs = getRefsForTab(tabId);
  expect(refs?.size).toBe(1);
  return [...(refs?.keys() ?? [])][0];
}

/**
 * Mock BrowserDriver. `axTrees` is consumed in FIFO order — each
 * captureSnapshot call pulls the next AX node array (the last entry repeats
 * if exhausted). Returns enough to satisfy clickByRef + captureSnapshot:
 * - Accessibility.getFullAXTree: AX tree
 * - Target.getTargetInfo: URL signal
 * - DOM.getBoxModel: a fixed quad so the click dispatches successfully
 * - DOM.resolveNode + Runtime.callFunctionOn: atomic gBCR for click coords
 * - Runtime.evaluate: viewport metrics + layout-flush rAF promise
 * Everything else returns {}.
 */
function makeMockDriver(opts: {
  axTrees: Array<Array<unknown>>;
  url: string;
}): BrowserDriver {
  let axIdx = 0;
  return {
    sendCommand: async (
      _tabId: unknown,
      method: string,
      _params?: unknown,
    ): Promise<unknown> => {
      if (method === "Accessibility.getFullAXTree") {
        const nodes =
          opts.axTrees[Math.min(axIdx, opts.axTrees.length - 1)] ?? [];
        axIdx++;
        return { nodes };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { url: opts.url } };
      }
      if (method === "DOM.getBoxModel") {
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "obj-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        // Atomic gBCR read used by clickByRef. Element rect at (0,0)+10x10,
        // viewport 1280x800, no scroll.
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
      if (method === "Runtime.evaluate") {
        // Two callers in scope:
        // - waitForLayoutFlush: awaits a rAF promise; any non-throw is fine.
        // - viewport-only snapshot path: scroll + viewport. Returning a
        //   uniform metrics object covers both.
        return {
          result: {
            value: { sx: 0, sy: 0, iw: 1280, ih: 800 },
          },
        };
      }
      return {};
    },
    getTab: async () => ({ id: TAB_ID, url: opts.url, title: "test" }),
    waitForLoad: async () => undefined,
    sendToContentScript: async () => ({ success: true }),
  } as unknown as BrowserDriver;
}

function makeCtx(driver: BrowserDriver): ToolContext {
  return {
    driver,
    session: {
      conversationId: null,
      resolveHandle: (_h: string) => TAB_ID,
    },
  } as unknown as ToolContext;
}

beforeEach(() => {
  invalidateRefs(TAB_ID);
});

// A bare button node. With no parentId it becomes the tree root; renderTree
// emits it (interactive role → @ref). backendDOMNodeId 99 is what clickByRef
// dispatches against.
function buttonNode(extra: Record<string, unknown> = {}) {
  return {
    nodeId: "1",
    role: { value: "button" },
    name: { value: "OK" },
    backendDOMNodeId: 99,
    ...extra,
  };
}

describe("clickElement post-action snapshot", () => {
  it("returns the post-action viewport snapshot in the `snapshot` field", async () => {
    // Action tools no longer return a `diff`. They auto-attach a fresh
    // viewport-scoped snapshot of the page state AFTER the click so the
    // model can pick its next ref directly. (Diff semantics caused
    // hallucinations when the prior snapshot was viewport-scoped and the
    // post-action one was full-tree — see the rewrite of click-element.ts.)
    const tree = [buttonNode()];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL });

    await captureSnapshot(driver, TAB_ID);
    const ref = onlyRef(TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    // Old `diff` field is intentionally gone.
    expect("diff" in result).toBe(false);
    // New shape: viewport snapshot text, ref count, URL.
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot).toContain('button "OK"');
    expect(result.refCount).toBe(1);
    expect(result.url).toBe(URL);
  });

  it("returns the snapshot even when the post-action page state is unchanged", async () => {
    // Identical before/after AX trees. With the diff-based design this used
    // to emit a `diff: null` + a "do not retry" note. Now we just hand the
    // model the viewport snapshot and let it judge whether the action
    // worked from the snapshot text and its own memory of the prior state.
    const tree = [buttonNode()];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL });

    await captureSnapshot(driver, TAB_ID);
    const ref = onlyRef(TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect("diff" in result).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot).toContain('button "OK"');
  });
});

describe("clickElement viewport-scoped post-action snapshot — regression", () => {
  it("does NOT diff a prior viewport-scoped snapshot against a full-tree post-action capture", async () => {
    // The historic bug: the user takes a viewport-scoped snapshot. The
    // model clicks an element. The post-action capture defaulted to a
    // full-tree snapshot. The diff therefore showed every below-fold
    // element as `[+] added` and every viewport-rendered subtree pruned by
    // a different rule as `[-] removed` — driving the model to hallucinate
    // that the click had radically transformed the page.
    //
    // After the rewrite, action tools no longer diff; they capture a fresh
    // viewport-scoped snapshot. So even with mode-asymmetric prior state,
    // the result is just "here is the viewport now" — no false [+]/[-]
    // lines.
    const tree = [buttonNode()];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL });
    await captureSnapshot(driver, TAB_ID);
    const ref = onlyRef(TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.snapshot).toBeDefined();
    // No diff syntax anywhere in the response.
    expect(result.snapshot).not.toMatch(/^\[\+\] /m);
    expect(result.snapshot).not.toMatch(/^\[-\] /m);
    expect(result.snapshot).not.toMatch(/major change:/);
    // Confirm the snapshot is the post-action tree, NOT a diff payload.
    expect(result.snapshot).toContain('button "OK"');
  });
});
