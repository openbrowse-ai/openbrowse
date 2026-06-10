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

describe("typeInElement signal-only diff", () => {
  it("returns non-null diff when only the focus signal changed", async () => {
    const before = tree(false); // no focus
    const after = tree(true); // focus moved to the (non-rendered) node
    const driver = makeMockDriver({ axTrees: [before, after], url: URL });

    // Priming capture establishes baseline (focusedBackendNodeId null).
    await captureSnapshot(driver, TAB_ID);

    // The visible textbox is the single interactive node → one stable ref.
    const refs = getRefsForTab(TAB_ID);
    expect(refs?.size).toBe(1);
    const ref = [...(refs?.keys() ?? [])][0];
    expect(ref).toMatch(/^@e/);

    const result = await typeInElementTool.execute(
      { tab: "t1", target: ref, text: "hi" },
      makeCtx(driver),
    );

    expect(result.typed).toBe(true);
    expect(result.diff).not.toBeNull();
    expect(result.diff).toContain("focus moved");
    expect(result.note).toBeUndefined();
  });
});
