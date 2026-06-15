import { beforeEach, describe, expect, it } from "vitest";
import { invalidateRefs, getRefsForTab } from "../../ref-store";
import { captureSnapshot } from "../../snapshot-capture";
import { typeInElementTool } from "../type-in-element";
import type { BrowserDriver, ToolContext } from "../../driver";

const TAB_ID = 1;
const URL = "https://example.com";

/**
 * Mock BrowserDriver — see click-element-diff.test.ts for the full rationale.
 * typeByRef issues DOM.focus / Input.dispatchKeyEvent / Input.insertText; all
 * return {} (none of their results are read). No DOM.getBoxModel needed here.
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
      if (method === "Runtime.evaluate") {
        // Used by the viewport-only snapshot path (scroll + viewport size).
        return {
          result: { value: { sx: 0, sy: 0, iw: 1280, ih: 800 } },
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

// A page root with a visible textbox (→ @e1, the type target) plus an
// `ignored` sibling node. The ignored node never renders (buildTree marks it
// not-visible, renderTree skips it) but derivePageStateSignals still reads its
// `focused` property — so toggling focus on it changes the focus SIGNAL while
// leaving the rendered snapshot TEXT byte-for-byte identical. That is exactly
// the signal-only path under test.
function tree(focusOnHiddenNode: boolean) {
  return [
    {
      nodeId: "root",
      role: { value: "RootWebArea" },
      name: { value: "" },
      childIds: ["1", "2"],
    },
    {
      nodeId: "1",
      role: { value: "textbox" },
      name: { value: "Email" },
      backendDOMNodeId: 5,
      parentId: "root",
    },
    {
      nodeId: "2",
      role: { value: "generic" },
      name: { value: "" },
      backendDOMNodeId: 7,
      parentId: "root",
      ignored: true,
      properties: focusOnHiddenNode
        ? [{ name: "focused", value: { value: true } }]
        : [],
    },
  ];
}

describe("typeInElement post-action snapshot", () => {
  it("returns the post-action viewport snapshot in the `snapshot` field", async () => {
    // Action tools no longer return a `diff`. They auto-attach a fresh
    // viewport-scoped snapshot of the page state AFTER the action so the
    // model can pick its next ref directly. See click-element.ts for the
    // rewrite rationale (mode-asymmetric diffs were hallucinating).
    const before = tree(false);
    const after = tree(true);
    const driver = makeMockDriver({ axTrees: [before, after], url: URL });

    await captureSnapshot(driver, TAB_ID);

    const refs = getRefsForTab(TAB_ID);
    expect(refs?.size).toBe(1);
    const ref = [...(refs?.keys() ?? [])][0];
    expect(ref).toMatch(/^@e/);

    const result = await typeInElementTool.execute(
      { tab: "t1", target: ref, text: "hi" },
      makeCtx(driver),
    );

    expect(result.typed).toBe(true);
    expect("diff" in result).toBe(false);
    expect(result.snapshot).toBeDefined();
    // The post-action snapshot must contain the textbox (it's the only
    // visible interactive element). Don't assert tree(after)'s focus
    // property — that's an internal signal, not rendered text.
    expect(result.snapshot).toContain('textbox "Email"');
    expect(result.refCount).toBe(1);
    expect(result.url).toBe(URL);
  });
});
