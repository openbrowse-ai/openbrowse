import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reopenTabsOnce } from "../reopen-tabs-once";

const created: { url?: string; windowId?: number; pinned?: boolean }[] = [];

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal("chrome", {
    tabs: {
      create: (props: { url?: string; windowId?: number; pinned?: boolean }) => {
        created.push(props);
        return Promise.resolve({ id: created.length });
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const undo = (id: string | undefined, n: number) => ({
  action: "reopen" as const,
  id,
  tabs: Array.from({ length: n }, (_, i) => ({
    url: `https://x/${i}`,
    windowId: 1,
    pinned: false,
  })),
});

describe("reopenTabsOnce", () => {
  it("reopens each tab and returns the count", async () => {
    const consumed = new Set<string>();
    const n = await reopenTabsOnce(undo("u1", 2), consumed);
    expect(n).toBe(2);
    expect(created).toEqual([
      { url: "https://x/0", windowId: 1, pinned: false },
      { url: "https://x/1", windowId: 1, pinned: false },
    ]);
  });

  it("is idempotent for the same id (second call is a no-op)", async () => {
    const consumed = new Set<string>();
    await reopenTabsOnce(undo("u1", 2), consumed);
    created.length = 0;
    const n = await reopenTabsOnce(undo("u1", 2), consumed);
    expect(n).toBe(0);
    expect(created).toEqual([]);
  });

  it("reopens distinct ids independently", async () => {
    const consumed = new Set<string>();
    await reopenTabsOnce(undo("u1", 1), consumed);
    const n = await reopenTabsOnce(undo("u2", 1), consumed);
    expect(n).toBe(1);
    expect(created).toHaveLength(2);
  });

  it("always applies a payload with no id (no dedup key)", async () => {
    const consumed = new Set<string>();
    await reopenTabsOnce(undo(undefined, 1), consumed);
    const n = await reopenTabsOnce(undo(undefined, 1), consumed);
    expect(n).toBe(1);
    expect(created).toHaveLength(2);
  });

  it("no-ops on empty tabs", async () => {
    const consumed = new Set<string>();
    const n = await reopenTabsOnce(undo("u1", 0), consumed);
    expect(n).toBe(0);
    expect(created).toEqual([]);
  });

  it("marks consumed before awaiting so concurrent calls dedupe", async () => {
    const consumed = new Set<string>();
    const u = undo("u1", 1);
    const [a, b] = await Promise.all([
      reopenTabsOnce(u, consumed),
      reopenTabsOnce(u, consumed),
    ]);
    // Exactly one of the two concurrent calls performs the reopen.
    expect([a, b].sort()).toEqual([0, 1]);
    expect(created).toHaveLength(1);
  });
});
