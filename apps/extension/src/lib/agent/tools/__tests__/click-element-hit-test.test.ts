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
}): BrowserDriver {
  let axIdx = 0;
  return {
    sendCommand: async (
      _tabId: unknown,
      method: string,
      _params?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (method === "Accessibility.getFullAXTree") {
        const nodes = opts.axTrees[Math.min(axIdx, opts.axTrees.length - 1)] ?? [];
        axIdx++;
        return { nodes };
      }
      if (method === "Target.getTargetInfo") return { targetInfo: { url: opts.url } };
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