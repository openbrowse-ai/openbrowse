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
 * Strategy is two-tier:
 *
 *   - **Tier 1**: a single whole-tree `Accessibility.getFullAXTree()` (no
 *     `frameId`). Chrome stitches the AX tree across frames on its end,
 *     preserving legitimate iframe content (Stripe, YouTube, etc.). This
 *     succeeds on benign pages AND on most pages that only have a foreign
 *     extension iframe loaded but not actively in the AX walk.
 *   - **Tier 2 (only on cross-extension rejection)**: enumerate frames
 *     with `Page.getFrameTree`, then call
 *     `Accessibility.getFullAXTree({frameId: <main>})` to walk just the
 *     main frame. Legitimate child-frame content is unavailable in this
 *     mode; the agent is told via `note`.
 *
 * These tests pin down both tiers by stubbing `driver.sendCommand`
 * per-method.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { captureSnapshot } from "../snapshot-capture";
import { invalidateRefs } from "../ref-store";
import type { BrowserDriver, TabId } from "../driver";

const TAB_ID = 1 as TabId;

beforeEach(() => invalidateRefs(TAB_ID));

const CROSS_EXT_ERR =
  "Cannot access a chrome-extension:// URL of different extension";

interface FrameTreeNode {
  frame: { id: string; url?: string };
  childFrames?: FrameTreeNode[];
}

interface MockOpts {
  /** Result of the whole-tree (no-frameId) Accessibility.getFullAXTree call. */
  wholeTree?: { nodes: unknown[] } | "cross-ext-error" | "throws";
  /** Frame tree returned by Page.getFrameTree (Tier 2 only). Omit to simulate Page domain unavailable. */
  frameTree?: FrameTreeNode;
  /**
   * Per-frame AX nodes keyed by frameId. Tier 2 only ever calls with the
   * main frame's id; entries for other frames exist only to assert we
   * don't accidentally walk them.
   */
  axNodesByFrame?: Record<string, unknown[]>;
  /** Frame ids that should reject with cross-extension when walked individually. */
  crossExtRejectFrames?: string[];
  url?: string;
}

function makeMock(opts: MockOpts): {
  driver: BrowserDriver;
  calls: { method: string; params?: Record<string, unknown> }[];
} {
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
        if (frameId == null) {
          // Tier 1 whole-tree call.
          if (opts.wholeTree === "cross-ext-error") {
            throw new Error(CROSS_EXT_ERR);
          }
          if (opts.wholeTree === "throws") {
            throw new Error("Some unrelated error");
          }
          return { nodes: opts.wholeTree?.nodes ?? [] };
        }
        // Tier 2 per-frame (main-only) call.
        if (opts.crossExtRejectFrames?.includes(frameId)) {
          throw new Error(CROSS_EXT_ERR);
        }
        return { nodes: opts.axNodesByFrame?.[frameId] ?? [] };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { url: opts.url ?? "https://example.com" } };
      }
      // Visibility / cursor / etc. — return empty so tests focus on AX.
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

describe("captureSnapshot: Tier 1 (whole-tree) — common case", () => {
  it("returns the whole-tree AX walk on a benign page; never invokes Page.getFrameTree", async () => {
    const { driver, calls } = makeMock({
      wholeTree: { nodes: [root(["b"]), btn("b", "Hello", 1)] },
    });
    const result = await captureSnapshot(driver, TAB_ID);

    // Content from the whole-tree walk surfaces in the snapshot.
    expect(result.snapshotText).toContain("Hello");

    // No degraded note on the happy path.
    expect(result.note).toBeUndefined();

    // Crucially: no Page.getFrameTree round-trip. Tier 1 is the entire path.
    const sawGetFrameTree = calls.some((c) => c.method === "Page.getFrameTree");
    expect(sawGetFrameTree).toBe(false);

    // Exactly one Accessibility.getFullAXTree call, with no frameId param.
    const axCalls = calls.filter(
      (c) => c.method === "Accessibility.getFullAXTree",
    );
    expect(axCalls).toHaveLength(1);
    expect(axCalls[0].params?.frameId).toBeUndefined();
  });

  it("preserves legitimate child-frame content via Chrome's whole-tree stitching", async () => {
    // Chrome's no-frameId getFullAXTree stitches main + legitimate iframes
    // into one connected forest. We model that by having the mock return
    // both frames' nodes in a single response with the main frame's
    // RootWebArea as the only parentless node — the legitimate iframe
    // descendants attach via parentId. This mirrors real Chrome output.
    const { driver } = makeMock({
      wholeTree: {
        nodes: [
          root(["main-btn", "embed-host"]),
          btn("main-btn", "MainBtn", 1),
          // The iframe-element wrapper in the main frame whose children
          // are nodes from the embedded frame, tagged with frameId.
          {
            nodeId: "embed-host",
            role: { value: "Iframe" },
            name: { value: "" },
            backendDOMNodeId: 100,
            parentId: "root",
            childIds: ["embed-btn"],
          },
          {
            nodeId: "embed-btn",
            role: { value: "button" },
            name: { value: "EmbedBtn" },
            backendDOMNodeId: 2,
            parentId: "embed-host",
            frameId: "EMBED",
          },
        ],
      },
    });
    const result = await captureSnapshot(driver, TAB_ID);
    // Both subtrees must appear in the rendered snapshot — this is the
    // regression Finding #2 was about: per-frame walking would silently
    // drop one of them.
    expect(result.snapshotText).toContain("MainBtn");
    expect(result.snapshotText).toContain("EmbedBtn");
    expect(result.note).toBeUndefined();
  });

  it("rethrows non-cross-extension errors so the cdp-session retry path can handle them", async () => {
    const { driver } = makeMock({ wholeTree: "throws" });
    await expect(captureSnapshot(driver, TAB_ID)).rejects.toThrow(
      /Some unrelated error/,
    );
  });
});

describe("captureSnapshot: Tier 2 (main-frame fallback) — hostile pages", () => {
  it("falls back to main-frame-only walk on cross-extension error and surfaces an attribution note", async () => {
    const { driver, calls } = makeMock({
      wholeTree: "cross-ext-error",
      frameTree: {
        frame: { id: "MAIN", url: "https://example.com/" },
        childFrames: [
          {
            frame: {
              id: "ONEPW",
              url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/iframe.html",
            },
          },
        ],
      },
      axNodesByFrame: {
        MAIN: [root(["save"]), btn("save", "Save", 5)],
      },
    });
    const result = await captureSnapshot(driver, TAB_ID);

    // Main-frame content rendered.
    expect(result.snapshotText).toContain("Save");

    // Note attributes the exclusion to a cross-extension iframe AND
    // claims main-page interactivity is unaffected (true in this case —
    // foreign-only, no raced frames).
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/excluded 1 frame/i);
    expect(result.note).toMatch(/chrome-extension/i);
    expect(result.note).toMatch(/main page are unaffected/i);

    // Tier 2 issued exactly the right calls.
    const axCalls = calls.filter(
      (c) => c.method === "Accessibility.getFullAXTree",
    );
    // First (failing) whole-tree call + second main-frame-only call.
    expect(axCalls).toHaveLength(2);
    expect(axCalls[0].params?.frameId).toBeUndefined();
    expect(axCalls[1].params?.frameId).toBe("MAIN");

    // The hostile frame is NOT walked individually. Tier 2 only walks
    // the main frame.
    const walkedFrameIds = axCalls
      .map((c) => c.params?.frameId)
      .filter((id): id is string => typeof id === "string");
    expect(walkedFrameIds).not.toContain("ONEPW");
  });

  it("softens the note language when the main frame itself races into a cross-extension reject", async () => {
    // A pathological case: the foreign extension iframe is attached such
    // that even main-frame-scoped getFullAXTree rejects. The note
    // should NOT make the "main page unaffected" claim because we lost
    // visibility into a frame that wasn't a foreign-extension URL.
    const { driver } = makeMock({
      wholeTree: "cross-ext-error",
      frameTree: { frame: { id: "MAIN", url: "https://example.com/" } },
      crossExtRejectFrames: ["MAIN"],
    });
    const result = await captureSnapshot(driver, TAB_ID);
    expect(result.note).toBeDefined();
    // Raced-frame language present.
    expect(result.note).toMatch(/errored mid-walk/i);
    expect(result.note).toMatch(/retry if expected content is missing/i);
    // Importantly: NO "main page are unaffected" claim — the reviewer's
    // concern (Finding #1) was that this language was sometimes false.
    expect(result.note).not.toMatch(/main page are unaffected/i);
  });

  it("emits a generic 'frame tree not enumerable' note when Page.getFrameTree is unavailable post-rejection", async () => {
    const { driver } = makeMock({
      wholeTree: "cross-ext-error",
      frameTree: undefined, // Page domain unavailable in Tier 2
    });
    const result = await captureSnapshot(driver, TAB_ID);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/blocked by a cross-extension iframe/i);
    expect(result.note).toMatch(/could not be enumerated/i);
  });

  it("does NOT walk other safe frames — only the main frame — even when the frame tree contains nested non-extension iframes", async () => {
    // Regression for Finding #2: under the old "always per-frame" design
    // we'd have walked MAIN and EMBED individually and concatenated their
    // RootWebAreas, which buildTree would then collapse to one. Tier 2
    // must walk ONLY MAIN.
    const { driver, calls } = makeMock({
      wholeTree: "cross-ext-error",
      frameTree: {
        frame: { id: "MAIN", url: "https://example.com/" },
        childFrames: [
          {
            frame: { id: "EMBED", url: "https://embed.example.com/" },
            childFrames: [
              {
                frame: {
                  id: "ONEPW-NESTED",
                  url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.html",
                },
              },
            ],
          },
        ],
      },
      axNodesByFrame: {
        MAIN: [root(["m"]), btn("m", "MainBtn", 1)],
        EMBED: [root(["e"]), btn("e", "EmbedBtn", 2)],
      },
    });
    const result = await captureSnapshot(driver, TAB_ID);
    expect(result.snapshotText).toContain("MainBtn");
    // EmbedBtn is unavailable in Tier 2 — that's the documented tradeoff.
    expect(result.snapshotText).not.toContain("EmbedBtn");

    const walked = calls
      .filter((c) => c.method === "Accessibility.getFullAXTree")
      .map((c) => c.params?.frameId);
    // First entry is undefined (the failing whole-tree call), then MAIN.
    expect(walked).toEqual([undefined, "MAIN"]);
  });
});
