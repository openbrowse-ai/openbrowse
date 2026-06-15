import { beforeEach, describe, expect, it } from "vitest";
import { invalidateRefs, getRefsForTab } from "../../ref-store";
import { captureSnapshot } from "../../snapshot-capture";
import { pressKeyTool } from "../press-key";
import type { BrowserDriver, ToolContext } from "../../driver";

const TAB_ID = 1;
const URL = "https://example.com";

function makeMockDriver(opts: {
  axTrees: Array<Array<unknown>>;
  url: string;
  keyEvents: Array<Record<string, unknown>>;
}): BrowserDriver {
  let axIdx = 0;
  return {
    sendCommand: async (
      _tabId: unknown,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (method === "Accessibility.getFullAXTree") {
        const nodes =
          opts.axTrees[Math.min(axIdx, opts.axTrees.length - 1)] ?? [];
        axIdx++;
        return { nodes };
      }
      if (method === "Target.getTargetInfo") return { targetInfo: { url: opts.url } };
      if (method === "Input.dispatchKeyEvent") {
        opts.keyEvents.push(params ?? {});
        return {};
      }
      if (method === "Runtime.evaluate") {
        // Two readers route through Runtime.evaluate here:
        //   - readViewportMetrics (viewport.ts) — reads { sx, sy, iw, ih }.
        //   - getViewportInfo (snapshot-capture.ts) — reads { sy, vh }.
        // The mock returns a superset so both readers see consistent data.
        return {
          result: { value: { sx: 0, sy: 0, iw: 1280, ih: 800, vh: 800 } },
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

describe("pressKey", () => {
  it("dispatches a keyDown+keyUp for a named key", async () => {
    const tree = [buttonNode()];
    const keyEvents: Array<Record<string, unknown>> = [];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL, keyEvents });
    await captureSnapshot(driver, TAB_ID); // baseline

    const result = await pressKeyTool.execute({ tab: "t1", key: "Escape" }, makeCtx(driver));

    expect(result.pressed).toBe(true);
    expect(result.key).toBe("Escape");
    const downs = keyEvents.filter((e) => e.type === "keyDown");
    const ups = keyEvents.filter((e) => e.type === "keyUp");
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(downs[0]).toMatchObject({ key: "Escape", code: "Escape" });
  });

  it("parses a modifier combo (ctrl+a) into a masked dispatch", async () => {
    const tree = [buttonNode()];
    const keyEvents: Array<Record<string, unknown>> = [];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL, keyEvents });
    await captureSnapshot(driver, TAB_ID);

    await pressKeyTool.execute({ tab: "t1", key: "ctrl+a" }, makeCtx(driver));

    const down = keyEvents.find((e) => e.type === "keyDown");
    expect(down).toMatchObject({ key: "a", modifiers: 2 });
  });

  it("focuses the target ref before dispatching when target is given", async () => {
    const tree = [buttonNode()];
    const keyEvents: Array<Record<string, unknown>> = [];
    let focusedBackendNodeId: number | undefined;
    const base = makeMockDriver({ axTrees: [tree, tree], url: URL, keyEvents });
    const driver = {
      ...base,
      sendCommand: async (tab: unknown, method: string, params?: Record<string, unknown>) => {
        if (method === "DOM.focus") focusedBackendNodeId = params?.backendNodeId as number | undefined;
        return (base.sendCommand as any)(tab, method, params);
      },
    } as unknown as BrowserDriver;
    await captureSnapshot(driver, TAB_ID); // resolves the ref -> backendNodeId 99

    const ref = [...(getRefsForTab(TAB_ID)?.keys() ?? [])][0];
    await pressKeyTool.execute({ tab: "t1", key: "Enter", target: ref }, makeCtx(driver));

    expect(focusedBackendNodeId).toBe(99);
  });

  it("returns the post-action viewport snapshot in the `snapshot` field", async () => {
    // Action tools no longer return a `diff`. They auto-attach a fresh
    // viewport-scoped snapshot of the page state AFTER the action so the
    // model can pick its next ref directly.
    const tree = [buttonNode()];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL, keyEvents: [] });
    await captureSnapshot(driver, TAB_ID);

    const result = await pressKeyTool.execute({ tab: "t1", key: "ArrowDown" }, makeCtx(driver));

    expect(result.pressed).toBe(true);
    expect("diff" in result).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot).toContain('button "OK"');
    expect(result.refCount).toBe(1);
    expect(result.url).toBe(URL);
  });
});
