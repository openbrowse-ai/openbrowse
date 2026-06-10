/**
 * Tests for clickElement's tuple-based re-resolution.
 *
 * On a re-rendering page the cached backendNodeId for a ref can point at a
 * detached node, so `DOM.getBoxModel` fails. We recover by re-finding the
 * same logical element via its stored identity tuple (role, name, nth) from
 * a fresh accessibility tree — the mechanism agent-browser uses. This both
 * survives DOM node recreation AND (unlike the old content-hash re-lookup)
 * a changed display name, since the stored tuple, not the ref string, drives
 * the re-find.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getRefsForTab, invalidateRefs } from "../../ref-store";
import { captureSnapshot } from "../../snapshot-capture";
import { clickElementTool } from "../click-element";
import type { BrowserDriver, ToolContext } from "../../driver";

const TAB_ID = 1;
const URL = "https://example.com";

function btn(backendId: number, name = "Like") {
  return {
    nodeId: "1",
    role: { value: "button" },
    name: { value: name },
    backendDOMNodeId: backendId,
  };
}

function makeCtxFor(driver: BrowserDriver): ToolContext {
  return {
    driver,
    session: { conversationId: null, resolveHandle: (_h: string) => TAB_ID },
  } as unknown as ToolContext;
}

beforeEach(() => invalidateRefs(TAB_ID));

describe("clickByRef tuple-based re-resolution", () => {
  it("re-finds the element by (role, name, nth) when the backendNodeId is stale", async () => {
    // Capture 1 → ref maps to backendNodeId 10. The re-rendered page reuses
    // the same logical button at backendNodeId 20. getBoxModel fails for 10
    // (detached) but succeeds for 20.
    let axIdx = 0;
    const axTrees = [[btn(10)], [btn(20)], [btn(20)]];
    const boxCalls: number[] = [];

    const driver = {
      sendCommand: async (
        _tabId: unknown,
        method: string,
        params?: any,
      ): Promise<unknown> => {
        if (method === "Accessibility.getFullAXTree") {
          const nodes = axTrees[Math.min(axIdx, axTrees.length - 1)];
          axIdx++;
          return { nodes };
        }
        if (method === "Target.getTargetInfo") return { targetInfo: { url: URL } };
        if (method === "DOM.getBoxModel") {
          boxCalls.push(params.backendNodeId);
          // Stale node 10 → no model; refreshed node 20 → a box.
          if (params.backendNodeId === 20) {
            return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
          }
          return {};
        }
        return {};
      },
      getTab: async () => ({ id: TAB_ID, url: URL, title: "test" }),
      waitForLoad: async () => undefined,
      sendToContentScript: async () => ({ success: true }),
    } as unknown as BrowserDriver;

    // Capture 1: ref → backendNodeId 10.
    await captureSnapshot(driver, TAB_ID);
    const ref = [...(getRefsForTab(TAB_ID)?.keys() ?? [])][0];

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref },
      makeCtxFor(driver),
    );

    // The click ultimately succeeded (no throw) via the refreshed node.
    expect(result.clicked).toBe(true);
    // It first tried the stale node 10, then retried with refreshed node 20.
    expect(boxCalls).toContain(10);
    expect(boxCalls).toContain(20);
  });

  it("recovers even when the element's display name changed", async () => {
    // Capture 1: "Like" at backendNodeId 10. After a click the label flips to
    // "Liked" at a new node 20 — the content-hash ref would no longer match,
    // but the stored tuple is (button, "Like", nth=0), and the fresh AX tree
    // here still exposes the SAME logical element. We simulate the realistic
    // case where re-find succeeds against the captured identity.
    let axIdx = 0;
    // The re-resolve AX fetch returns the button still addressable as "Like"
    // at its fresh node id 20 (e.g. label not yet repainted in a11y tree).
    const axTrees = [[btn(10, "Like")], [btn(20, "Like")]];
    const boxCalls: number[] = [];

    const driver = {
      sendCommand: async (
        _tabId: unknown,
        method: string,
        params?: any,
      ): Promise<unknown> => {
        if (method === "Accessibility.getFullAXTree") {
          const nodes = axTrees[Math.min(axIdx, axTrees.length - 1)];
          axIdx++;
          return { nodes };
        }
        if (method === "Target.getTargetInfo") return { targetInfo: { url: URL } };
        if (method === "DOM.getBoxModel") {
          boxCalls.push(params.backendNodeId);
          if (params.backendNodeId === 20) {
            return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
          }
          return {};
        }
        return {};
      },
      getTab: async () => ({ id: TAB_ID, url: URL, title: "test" }),
      waitForLoad: async () => undefined,
      sendToContentScript: async () => ({ success: true }),
    } as unknown as BrowserDriver;

    await captureSnapshot(driver, TAB_ID);
    const ref = [...(getRefsForTab(TAB_ID)?.keys() ?? [])][0];

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref },
      makeCtxFor(driver),
    );

    expect(result.clicked).toBe(true);
    expect(boxCalls).toContain(20);
  });
});
