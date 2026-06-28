import { describe, expect, it } from "vitest";
import {
  getAgentWindow,
  setAgentWindow,
} from "../agent-transport";

/**
 * `setAgentWindow(cid, null)` (called from `agent-host/bootstrap.ts`
 * when `resolveConversationWindowId` returns `undefined`) used to
 * persist `null` into the cache. The next `ensureAgentWindow(cid)`
 * call would then see the cached `null`, short-circuit, and return
 * `undefined` — never re-running the resolver even if the window
 * became resolvable later (e.g. the conversation just hadn't bound to
 * a window yet at SW boot).
 *
 * Fix: `setAgentWindow` must skip null/undefined writes, treating them
 * as "no cache entry" so the lazy resolver can run again.
 */

describe("setAgentWindow / getAgentWindow caching", () => {
  it("retains a real numeric window id when set", () => {
    setAgentWindow("conv-B", 7);
    expect(getAgentWindow("conv-B")).toBe(7);
  });

  it("does NOT cache null (so a later set can replace it with a real id)", () => {
    setAgentWindow("conv-A-null", null);
    expect(getAgentWindow("conv-A-null")).toBeUndefined();
    // A subsequent real set should populate.
    setAgentWindow("conv-A-null", 42);
    expect(getAgentWindow("conv-A-null")).toBe(42);
  });

  it("setAgentWindow(undefined) does not poison the cache either", () => {
    setAgentWindow(
      "conv-C-undef",
      undefined as unknown as number | null,
    );
    expect(getAgentWindow("conv-C-undef")).toBeUndefined();
    setAgentWindow("conv-C-undef", 3);
    expect(getAgentWindow("conv-C-undef")).toBe(3);
  });

  it("setAgentWindow(null) does NOT erase a previously-cached real id", () => {
    // Tests the second-call-overwrites-with-null guard: bootstrap might
    // call `setAgentWindow(cid, resolveConversationWindowId() ?? null)`
    // a second time when the resolver returns undefined; that must not
    // clobber the cached real value from an earlier successful resolve.
    setAgentWindow("conv-D", 99);
    setAgentWindow("conv-D", null);
    expect(getAgentWindow("conv-D")).toBe(99);
  });
});
