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
 * captureSnapshot call pulls the next AX node array (the last entry repeats if
 * exhausted). Only Accessibility.getFullAXTree and Target.getTargetInfo return
 * meaningful data; everything else returns {} (the graceful try/catch helpers
 * in snapshot-capture cope) except DOM.getBoxModel, which must return a box so
 * clickByRef can dispatch the mouse events.
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
// emits it (interactive role → @e1). backendDOMNodeId 99 is what clickByRef
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

describe("clickElement diff:null note", () => {
  it("emits the reworded non-retry note on a true no-op", async () => {
    // before === after → identical text AND identical signals → null diff.
    const tree = [buttonNode()];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL });

    // Priming capture: establishes baseline refs + snapshot + signals via the
    // module-level ref store (setRefs is called internally). No manual setRefs
    // needed, which avoids text-matching fragility.
    await captureSnapshot(driver, TAB_ID);

    // Sanity: the single interactive button must have resolved to one ref.
    const ref1 = onlyRef(TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref1 },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.diff).toBeNull();
    expect(result.note).toBeDefined();
    expect(result.note).toContain("Do NOT");
    expect(result.note).toContain("blindly re-click");
    // The reworded note must NOT contain the old "may not have had the
    // expected effect" phrasing.
    expect(result.note).not.toMatch(/may not have had the expected effect/);
  });

  it("returns non-null diff when only signals changed (aria-pressed toggle)", async () => {
    // before: button not pressed; after: same button with aria-pressed=true.
    // `pressed` is NOT rendered by formatProps, so the snapshot TEXT is
    // identical before/after — this exercises the signal-only diff branch.
    const before = [buttonNode()];
    const after = [
      buttonNode({ properties: [{ name: "pressed", value: { value: true } }] }),
    ];
    const driver = makeMockDriver({ axTrees: [before, after], url: URL });

    await captureSnapshot(driver, TAB_ID); // baseline: pressedCount 0

    const ref2 = onlyRef(TAB_ID);

    const result = await clickElementTool.execute(
      { tab: "t1", target: ref2 },
      makeCtx(driver),
    );

    expect(result.clicked).toBe(true);
    expect(result.diff).not.toBeNull();
    expect(result.diff).toContain("aria-pressed count: 0 → 1");
    expect(result.note).toBeUndefined();
  });
});
