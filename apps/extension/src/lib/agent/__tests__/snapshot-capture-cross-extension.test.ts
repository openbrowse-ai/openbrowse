/**
 * Cross-extension iframe handling in `captureSnapshot`.
 *
 * Background: third-party Chrome extensions like 1Password, LastPass,
 * Bitwarden, and Honey inject content-script iframes served from
 * `chrome-extension://<otherExtId>/...` into normal http(s) tabs. The
 * tab-attached debugger we use is NOT permitted to inspect URLs from a
 * different extension — when `Accessibility.getFullAXTree` walks into
 * such an iframe, Chrome rejects the call and the capture path errors out.
 *
 * `snapshot-capture` runs a `Page.getFrameTree` pre-pass and walks each
 * non-foreign frame individually with `Accessibility.getFullAXTree({frameId})`.
 * Foreign frames are skipped preemptively; if the per-frame walk itself
 * trips a cross-extension reject (race: an iframe was injected between
 * the frame-tree pre-pass and the AX call), that frame is also skipped
 * and recorded in a `note` returned to the caller.
 *
 * These tests exercise the helper end-to-end through `captureSnapshot`,
 * stubbing `driver.sendCommand` per-method to mimic Chrome's responses.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { captureSnapshot } from "../snapshot-capture";
import { invalidateRefs } from "../ref-store";
import type { BrowserDriver, TabId } from "../driver";

const TAB_ID = 1 as TabId;

beforeEach(() => invalidateRefs(TAB_ID));

interface FrameTreeNode {
  frame: { id: string; url?: string };
  childFrames?: FrameTreeNode[];
}

interface MockOpts {
  frameTree: FrameTreeNode | undefined;
  /** Per-frame AX nodes keyed by frameId. Undefined frameId → top-level. */
  axNodesByFrame: Record<string, unknown[]>;
  /** Frame ids that should reject with a cross-extension error. */
  crossExtRejectFrames?: string[];
  url?: string;
}

function makeMock(opts: MockOpts): { driver: BrowserDriver; calls: { method: string; params?: Record<string, unknown> }[] } {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const driver: BrowserDriver = {
    sendCommand: async (
      _tabId: unknown,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") {
        return { frameTree: opts.frameTree };
      }
      if (method === "Accessibility.getFullAXTree") {
        const frameId = params?.frameId as string | undefined;
        if (frameId && opts.crossExtRejectFrames?.includes(frameId)) {
          throw new Error(
            "Cannot access a chrome-extension:// URL of different extension",
          );
        }
        const key = frameId ?? "__top__";
        return { nodes: opts.axNodesByFrame[key] ?? [] };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { url: opts.url ?? "https://example.com" } };
      }
      // Visibility / cursor calls — return empty so the test focuses on AX walking.
      return {};
    },
    getTab: async () => ({ id: TAB_ID, url: opts.url ?? "", title: "test" }),
    waitForLoad: async () => undefined,
    sendToContentScript: async () => ({ success: true }),
  } as unknown as BrowserDriver;
  return { driver, calls };
}

function root(childIds: string[]) {
  return {
    nodeId: "root",
    role: { value: "RootWebArea" },
    name: { value: "" },
    childIds,
  };
}
function btn(nodeId: string, name: string, backendId: number) {
  return {
    nodeId,
    role: { value: "button" },
    name: { value: name },
    backendDOMNodeId: backendId,
    parentId: "root",
  };
}

describe("captureSnapshot: cross-extension iframe handling", () => {
  it("excludes foreign chrome-extension:// frames and walks only safe ones", async () => {
    const frameTree: FrameTreeNode = {
      frame: { id: "MAIN", url: "https://example.com/" },
      childFrames: [
        {
          frame: {
            id: "ONEPW",
            url: "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/iframe.html",
          },
        },
      ],
    };
    const { driver, calls } = makeMock({
      frameTree,
      axNodesByFrame: {
        MAIN: [root(["click-me"]), btn("click-me", "Save", 5)],
      },
    });
    const result = await captureSnapshot(driver, TAB_ID);

    // Main frame walked; ONEPW frame must NOT be walked (preemptive skip).
    const axCalls = calls.filter(
      (c) => c.method === "Accessibility.getFullAXTree",
    );
    const walkedFrames = axCalls
      .map((c) => c.params?.frameId)
      .filter((id): id is string => typeof id === "string");
    expect(walkedFrames).toContain("MAIN");
    expect(walkedFrames).not.toContain("ONEPW");

    // Snapshot text comes from main-frame nodes.
    expect(result.snapshotText).toContain("Save");

    // Note tells the agent a frame was excluded.
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/excluded 1 frame/i);
    expect(result.note).toMatch(/chrome-extension/i);
  });

  it("falls back gracefully when a per-frame walk hits a race-injected cross-extension iframe", async () => {
    // The frame tree LOOKS clean (only main), but the per-frame AX call
    // for main throws the cross-extension error — simulating an iframe
    // that was injected between the pre-pass and the AX call.
    const frameTree: FrameTreeNode = {
      frame: { id: "MAIN", url: "https://example.com/" },
    };
    const { driver } = makeMock({
      frameTree,
      axNodesByFrame: {},
      crossExtRejectFrames: ["MAIN"],
    });
    // Should NOT throw — the helper catches the cross-ext error per-frame.
    // With no safe frame succeeding, the result has no nodes; the wrapper
    // falls into its empty-snapshot retry branch (which also catches and
    // produces an empty result with the racedFrames note).
    const result = await captureSnapshot(driver, TAB_ID);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/excluded/i);
  });

  it("walks normally when no foreign frames are present (single main frame)", async () => {
    const frameTree: FrameTreeNode = {
      frame: { id: "MAIN", url: "https://example.com/" },
    };
    const { driver, calls } = makeMock({
      frameTree,
      axNodesByFrame: {
        MAIN: [root(["b1"]), btn("b1", "Hello", 7)],
      },
    });
    const result = await captureSnapshot(driver, TAB_ID);
    expect(result.snapshotText).toContain("Hello");
    // No cross-extension exclusion => no note.
    expect(result.note).toBeUndefined();
    // One getFullAXTree call per safe frame.
    const axCalls = calls.filter(
      (c) => c.method === "Accessibility.getFullAXTree",
    );
    expect(axCalls.length).toBe(1);
    expect(axCalls[0].params?.frameId).toBe("MAIN");
  });

  it("falls back to legacy whole-tree when Page.getFrameTree is unavailable", async () => {
    // Older Chrome / non-Page targets may not return a frameTree. The
    // helper degrades to a single frame-id-less getFullAXTree.
    const { driver, calls } = makeMock({
      frameTree: undefined,
      axNodesByFrame: { __top__: [root(["b"]), btn("b", "OK", 1)] },
    });
    const result = await captureSnapshot(driver, TAB_ID);
    expect(result.snapshotText).toContain("OK");
    const axCall = calls.find(
      (c) => c.method === "Accessibility.getFullAXTree",
    );
    expect(axCall).toBeDefined();
    expect(axCall?.params?.frameId).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("walks nested safe frames and skips nested foreign frames", async () => {
    const frameTree: FrameTreeNode = {
      frame: { id: "MAIN", url: "https://example.com/" },
      childFrames: [
        {
          frame: { id: "EMBED", url: "https://embed.example.com/" },
          childFrames: [
            {
              frame: {
                id: "ONEPW-NESTED",
                url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html",
              },
            },
          ],
        },
      ],
    };
    const { driver, calls } = makeMock({
      frameTree,
      axNodesByFrame: {
        MAIN: [root(["m"]), btn("m", "MainBtn", 1)],
        EMBED: [root(["e"]), btn("e", "EmbedBtn", 2)],
      },
    });
    const result = await captureSnapshot(driver, TAB_ID);
    const walked = calls
      .filter((c) => c.method === "Accessibility.getFullAXTree")
      .map((c) => c.params?.frameId);
    expect(walked).toContain("MAIN");
    expect(walked).toContain("EMBED");
    expect(walked).not.toContain("ONEPW-NESTED");
    expect(result.note).toBeDefined();
  });
});
