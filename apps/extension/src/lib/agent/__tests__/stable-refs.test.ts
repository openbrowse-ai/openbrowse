/**
 * Tests for content-stable `@ref` assignment in snapshot-capture.
 *
 * The ref system used to be a per-snapshot ordinal counter (`@e1`, `@e2`, …
 * reassigned every capture), which meant the SAME logical element got a
 * different ref on every snapshot of a re-rendering page — the root cause of
 * "Ref not found. Refs may be stale" failures on sites like LinkedIn.
 *
 * Refs are now derived from element identity (role + accessible name +
 * nearest landmark + occurrence index), hashed to a stable `@e<base36>`
 * token. Invariants under test:
 *   - The same logical element keeps the same ref across two captures even
 *     when surrounding interactive elements are added/removed.
 *   - Two distinct elements sharing role+name are disambiguated (distinct
 *     stable refs) by occurrence index.
 *   - A ref taken from one snapshot still resolves after a later snapshot
 *     (via the ref-store carry-over), and resolves to the refreshed
 *     backendNodeId when the element persists.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { captureSnapshot, findNodeByRoleNameNth } from "../snapshot-capture";
import { getRef, getRefsForTab, invalidateRefs } from "../ref-store";
import type { BrowserDriver, TabId } from "../driver";

const TAB_ID = 1 as TabId;
const URL = "https://example.com";

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

beforeEach(() => invalidateRefs(TAB_ID));

describe("content-stable refs", () => {
  it("keeps the same ref for the same element across re-renders", async () => {
    // Capture 1: [Like, Comment]. Capture 2: a NEW button is inserted before
    // them ([Follow, Like, Comment]) — under the old ordinal scheme this would
    // shift Like from @e1→@e2. With stable ids, Like keeps its ref.
    const before = [
      root(["like", "comment"]),
      btn("like", "Like", 10),
      btn("comment", "Comment", 11),
    ];
    const after = [
      root(["follow", "like", "comment"]),
      btn("follow", "Follow", 9),
      btn("like", "Like", 10),
      btn("comment", "Comment", 11),
    ];
    const driver = makeMockDriver({ axTrees: [before, after], url: URL });

    const r1 = await captureSnapshot(driver, TAB_ID);
    const likeRef1 = refForName(r1.refs, "Like");
    const commentRef1 = refForName(r1.refs, "Comment");

    const r2 = await captureSnapshot(driver, TAB_ID);
    const likeRef2 = refForName(r2.refs, "Like");
    const commentRef2 = refForName(r2.refs, "Comment");

    expect(likeRef2).toBe(likeRef1);
    expect(commentRef2).toBe(commentRef1);
    // The newly inserted Follow button has its own distinct ref.
    expect(refForName(r2.refs, "Follow")).not.toBe(likeRef1);
  });

  it("disambiguates distinct elements that share role + name", async () => {
    const tree = [
      root(["c1", "c2", "c3"]),
      btn("c1", "Connect", 21),
      btn("c2", "Connect", 22),
      btn("c3", "Connect", 23),
    ];
    const driver = makeMockDriver({ axTrees: [tree], url: URL });
    const r = await captureSnapshot(driver, TAB_ID);

    const refs = [...r.refs.keys()];
    // Three Connect buttons → three distinct stable refs.
    expect(new Set(refs).size).toBe(3);
    // And every ref maps to a distinct backendNodeId.
    const backends = new Set([...r.refs.values()].map((e) => e.backendNodeId));
    expect(backends.size).toBe(3);
  });

  it("resolves a ref via carry-over after a later snapshot drops it", async () => {
    // Capture 1 has the Like button; capture 2 (e.g. viewport-scoped) no
    // longer includes it. The ref from capture 1 must still resolve thanks to
    // the bounded carry-over pool.
    const withLike = [root(["like"]), btn("like", "Like", 10)];
    const withoutLike = [root(["other"]), btn("other", "Other", 50)];
    const driver = makeMockDriver({
      axTrees: [withLike, withoutLike],
      url: URL,
    });

    const r1 = await captureSnapshot(driver, TAB_ID);
    const likeRef = refForName(r1.refs, "Like");

    await captureSnapshot(driver, TAB_ID); // latest no longer has Like

    // Not in the latest map…
    expect(getRefsForTab(TAB_ID)?.has(likeRef)).toBe(false);
    // …but still resolvable via carry-over.
    expect(getRef(TAB_ID, likeRef)?.backendNodeId).toBe(10);
  });
});

function refForName(
  refs: Map<string, { backendNodeId: number; name: string }>,
  name: string,
): string {
  for (const [ref, entry] of refs) {
    if (entry.name === name) return ref;
  }
  throw new Error(`no ref for element named "${name}"`);
}

describe("identity tuple (role, name, nth) on ref entries", () => {
  it("stores nth = frame-scoped occurrence index per (role, name)", async () => {
    const tree = [
      root(["c1", "c2", "c3"]),
      btn("c1", "Connect", 21),
      btn("c2", "Connect", 22),
      btn("c3", "Connect", 23),
    ];
    const driver = makeMockDriver({ axTrees: [tree], url: URL });
    const r = await captureSnapshot(driver, TAB_ID);

    // Three Connect buttons → nth 0, 1, 2 in document order.
    const byBackend = new Map(
      [...r.refs.values()].map((e) => [e.backendNodeId, e.nth]),
    );
    expect(byBackend.get(21)).toBe(0);
    expect(byBackend.get(22)).toBe(1);
    expect(byBackend.get(23)).toBe(2);
  });
});

describe("findNodeByRoleNameNth", () => {
  it("returns the backendNodeId of the nth (role, name) match", async () => {
    const tree = [
      root(["c1", "c2", "c3"]),
      btn("c1", "Connect", 21),
      btn("c2", "Connect", 22),
      btn("c3", "Connect", 23),
    ];
    const driver = makeMockDriver({ axTrees: [tree, tree], url: URL });
    await captureSnapshot(driver, TAB_ID);

    expect(await findNodeByRoleNameNth(driver, TAB_ID, "button", "Connect", 0)).toBe(21);
    expect(await findNodeByRoleNameNth(driver, TAB_ID, "button", "Connect", 1)).toBe(22);
    expect(await findNodeByRoleNameNth(driver, TAB_ID, "button", "Connect", 2)).toBe(23);
    // Out of range → null.
    expect(await findNodeByRoleNameNth(driver, TAB_ID, "button", "Connect", 5)).toBeNull();
    // No such element → null.
    expect(await findNodeByRoleNameNth(driver, TAB_ID, "button", "Ghost", 0)).toBeNull();
  });

  it("skips ignored nodes when counting matches", async () => {
    const tree = [
      root(["c1", "c2"]),
      { ...btn("c1", "Connect", 21), ignored: true },
      btn("c2", "Connect", 22),
    ];
    const driver = makeMockDriver({ axTrees: [tree], url: URL });
    // nth 0 should skip the ignored node and return the visible one.
    expect(await findNodeByRoleNameNth(driver, TAB_ID, "button", "Connect", 0)).toBe(22);
  });
});

describe("frameId on ref entries", () => {
  it("captures frameId when present on an AX node and omits it otherwise", async () => {
    const tree = [
      root(["top", "framed"]),
      btn("top", "Top", 30),
      { ...btn("framed", "InFrame", 31), frameId: "FRAME-7" },
    ];
    const driver = makeMockDriver({ axTrees: [tree], url: URL });
    const r = await captureSnapshot(driver, TAB_ID);

    const top = [...r.refs.values()].find((e) => e.backendNodeId === 30)!;
    const framed = [...r.refs.values()].find((e) => e.backendNodeId === 31)!;
    expect(top.frameId).toBeUndefined();
    expect(framed.frameId).toBe("FRAME-7");
  });
});
