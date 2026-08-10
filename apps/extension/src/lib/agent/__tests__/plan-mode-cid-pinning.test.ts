import { describe, expect, it, vi } from "vitest";
import { isInPlanCore } from "../agent-transport";
import type { ApprovedPlan } from "@/lib/types";

/**
 * Regression test for the cid-pinning contract in the Plan-mode
 * approval dispatcher.
 *
 * Background
 * ----------
 * The dispatcher in `needsApproval` resolves mode/plan via
 * `chatDb.getConversation(cid)` (an async read), then — if Plan mode
 * with a plan — calls `isInPlan(...)` which itself awaits a tab
 * resolution. Both reads need to refer to the SAME conversation,
 * even if the user switches conversations between the two awaits.
 *
 * The bug (now fixed): `isInPlan`'s tab resolution previously read
 * the module-level `agentConversationId` directly, picking up
 * whatever the global pointed at by the time the await scheduled —
 * not the conversation whose plan was just loaded. A mid-flight
 * switch could match plan A's `sites` list against conversation B's
 * tab map.
 *
 * The fix: pin `cid` once at the entry to the dispatcher's lambda
 * and thread it through. `isInPlanCore` (the pure policy core
 * extracted from the per-agent closure) takes `cid` as a parameter
 * and a `resolveTab` callback, so this test can drive the pinning
 * contract end-to-end without a live agent: the test's `resolveTab`
 * stub asserts the cid it sees is the pinned one.
 */

const samplePlan: ApprovedPlan = {
  goal: "research",
  sites: ["https://allowed.com"],
  allowNetwork: false,
  approvedAt: 1700000000000,
  extensions: [],
};

describe("isInPlanCore — cid-pinning contract", () => {
  it("threads the pinned cid through to resolveTab (does not read a module global)", async () => {
    // Stub resolver records the cid it's called with so the test
    // can assert the pinned cid was passed verbatim.
    const seenCids: Array<string | null> = [];
    const resolveTab = vi.fn(
      async (cid: string | null, _input: unknown) => {
        seenCids.push(cid);
        // Return a tab whose origin is in `samplePlan.sites` so the
        // result is in-plan when the right cid is threaded.
        return { tab: { url: "https://allowed.com/page" } };
      },
    );

    const result = await isInPlanCore(
      "snapshot",
      { tab: "t1" },
      samplePlan,
      "conversation-A",
      resolveTab,
    );

    expect(result).toBe(true);
    expect(resolveTab).toHaveBeenCalledTimes(1);
    expect(seenCids).toEqual(["conversation-A"]);
  });

  it("uses the pinned cid even if a separate concurrent invocation passes a different cid", async () => {
    // Simulates the race: two dispatches happen near-simultaneously,
    // each pinning their own cid. Without pinning, both calls would
    // read whichever cid the module global last settled to.
    const seenCids: Array<string | null> = [];
    const resolveTab = vi.fn(
      async (cid: string | null, _input: unknown) => {
        seenCids.push(cid);
        // Defer return so both invocations interleave on the
        // microtask queue before either resolveTab resolves.
        await Promise.resolve();
        return { tab: { url: "https://allowed.com/" } };
      },
    );

    const [a, b] = await Promise.all([
      isInPlanCore("snapshot", { tab: "t1" }, samplePlan, "cid-A", resolveTab),
      isInPlanCore("snapshot", { tab: "t1" }, samplePlan, "cid-B", resolveTab),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    // Both invocations saw their OWN pinned cid, not a shared module
    // global that one of them happened to set last.
    expect(seenCids.sort()).toEqual(["cid-A", "cid-B"]);
  });

  it("returns false (off-plan, prompt) when the tab origin is not in plan.sites", async () => {
    const resolveTab = vi.fn(async () => ({
      tab: { url: "https://elsewhere.com/" },
    }));
    const result = await isInPlanCore(
      "snapshot",
      { tab: "t1" },
      samplePlan,
      "cid",
      resolveTab,
    );
    expect(result).toBe(false);
  });

  it("FAIL CLOSED: returns false when the tab cannot be resolved", async () => {
    const resolveTab = vi.fn(async () => null);
    const result = await isInPlanCore(
      "snapshot",
      { tab: "stale-handle" },
      samplePlan,
      "cid",
      resolveTab,
    );
    expect(result).toBe(false);
  });

  it("FAIL CLOSED: returns false when the resolved tab's URL is missing", async () => {
    const resolveTab = vi.fn(async () => ({ tab: {} }));
    const result = await isInPlanCore(
      "snapshot",
      { tab: "t1" },
      samplePlan,
      "cid",
      resolveTab,
    );
    expect(result).toBe(false);
  });

  it("FAIL CLOSED: returns false when the resolved tab's URL is malformed", async () => {
    const resolveTab = vi.fn(async () => ({ tab: { url: "not a url" } }));
    const result = await isInPlanCore(
      "snapshot",
      { tab: "t1" },
      samplePlan,
      "cid",
      resolveTab,
    );
    expect(result).toBe(false);
  });

  it("non-tab-interacting tools are in-plan without consulting resolveTab", async () => {
    const resolveTab = vi.fn(async () => null);
    expect(
      await isInPlanCore(
        "todoWrite",
        {},
        samplePlan,
        "cid",
        resolveTab,
      ),
    ).toBe(true);
    expect(
      await isInPlanCore(
        "searchMemory",
        {},
        samplePlan,
        "cid",
        resolveTab,
      ),
    ).toBe(true);
    expect(resolveTab).not.toHaveBeenCalled();
  });

  it("proposePlan is always in-plan (the dispatcher gates it via the explicit branch)", async () => {
    const resolveTab = vi.fn();
    expect(
      await isInPlanCore(
        "proposePlan",
        {},
        samplePlan,
        "cid",
        resolveTab,
      ),
    ).toBe(true);
    expect(resolveTab).not.toHaveBeenCalled();
  });

  it("executePython without network is always in-plan", async () => {
    const resolveTab = vi.fn();
    expect(
      await isInPlanCore(
        "executePython",
        { code: "1+1" },
        samplePlan,
        "cid",
        resolveTab,
      ),
    ).toBe(true);
    expect(
      await isInPlanCore(
        "executePython",
        { code: "1+1", allow_network: false },
        samplePlan,
        "cid",
        resolveTab,
      ),
    ).toBe(true);
    expect(resolveTab).not.toHaveBeenCalled();
  });

  it("executePython with network defers to plan.allowNetwork", async () => {
    const resolveTab = vi.fn();
    const planNetOff: ApprovedPlan = { ...samplePlan, allowNetwork: false };
    const planNetOn: ApprovedPlan = { ...samplePlan, allowNetwork: true };

    expect(
      await isInPlanCore(
        "executePython",
        { code: "x", allow_network: true },
        planNetOff,
        "cid",
        resolveTab,
      ),
    ).toBe(false);
    expect(
      await isInPlanCore(
        "executePython",
        { code: "x", allow_network: true },
        planNetOn,
        "cid",
        resolveTab,
      ),
    ).toBe(true);
    expect(resolveTab).not.toHaveBeenCalled();
  });
});
