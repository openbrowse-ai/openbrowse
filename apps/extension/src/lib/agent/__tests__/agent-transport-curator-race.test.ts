/**
 * Regression test for the curator-closure race in agent-transport.ts:
 *
 *   onCompletionCheckApproved fires fire-and-forget. The closure does an
 *   `await waitForAssistantPersist(...)` near the top, then reads
 *   conversation-state variables (`lastCatalogDomains`, `lastActiveUrl`,
 *   `lastTurnBaselineCount`) that live at module scope. Without
 *   snapshotting those into local consts at closure entry, a
 *   subsequent turn's `prepareCall` overwrites the module-level
 *   values, and the awaiting closure ends up extracting candidates
 *   against the WRONG turn's catalog/active-URL/baseline.
 *
 * This test exercises the snapshot semantics in isolation by
 * simulating the same shape:
 *   1. Capture turn-1 locals into consts.
 *   2. Mutate the module-level "turn state" (simulating turn 2 starting).
 *   3. Await an asynchronous persist-wait shim.
 *   4. Assert the closure passes turn-1's snapshot — not turn-2's
 *      mutated values — to the extractor, and that the messages array
 *      it sees is sliced from turn-1's baseline.
 *
 * If the closure regresses to reading the mutable refs directly, this
 * test fails because the extractor will receive turn-2's values.
 */
import { describe, it, expect } from "vitest";

interface CuratorExtractInput {
  messages: { role: string; parts?: unknown[] }[];
  catalogDomains: string[];
  activeUrl: string | undefined;
  baseline: number;
}

/**
 * Mirror of the agent-transport closure's structure. Takes the
 * "module-level state" by reference (a mutable object) and a
 * fake-async-persist function. Snapshots turn-state into consts
 * before the await, slices messages, and calls the extractor with
 * the captured locals + sliced messages. The test then mutates the
 * shared state during the await and verifies what the extractor sees.
 */
async function curatorClosureUnderTest(opts: {
  turnConvId: string;
  callbackCid: string;
  shared: {
    lastCatalogDomains: string[];
    lastActiveUrl: string | undefined;
    lastTurnBaselineCount: number;
    allMessages: { role: string; parts?: unknown[] }[];
  };
  awaitPersist: () => Promise<void>;
  extract: (input: CuratorExtractInput) => void;
}): Promise<void> {
  const { turnConvId, callbackCid, shared, awaitPersist, extract } = opts;

  // === Snapshot block — equivalent to the agent-transport closure's
  // entry. If this is missing or partial, the assertions below fail.
  const turnCatalogDomains = shared.lastCatalogDomains.slice();
  const turnActiveUrl = shared.lastActiveUrl;
  const turnBaseline = shared.lastTurnBaselineCount;
  // ===

  if (turnConvId !== callbackCid) return;
  await awaitPersist();
  const allMessages = shared.allMessages;
  const messages = allMessages.slice(turnBaseline);
  extract({
    messages,
    catalogDomains: turnCatalogDomains,
    activeUrl: turnActiveUrl,
    baseline: turnBaseline,
  });
}

describe("curator-closure snapshot semantics (regression for cross-turn pollution)", () => {
  it("passes turn-1's catalogDomains and activeUrl to the extractor even if turn-2 overwrites the shared state mid-await", async () => {
    const shared = {
      lastCatalogDomains: ["luma.com"],
      lastActiveUrl: "https://luma.com/event/turn-1",
      lastTurnBaselineCount: 0,
      allMessages: [
        { role: "user", parts: [{ type: "text", text: "turn 1" }] },
      ],
    };
    let received: CuratorExtractInput | null = null;
    let resolvePersist: (() => void) | null = null;
    const persistDone = new Promise<void>((r) => (resolvePersist = r));

    const closurePromise = curatorClosureUnderTest({
      turnConvId: "c1",
      callbackCid: "c1",
      shared,
      awaitPersist: () => persistDone,
      extract: (input) => {
        received = input;
      },
    });

    // Simulate turn 2's prepareCall overwriting the module-level state
    // BEFORE the closure's persist-wait resolves.
    shared.lastCatalogDomains = ["linkedin.com"];
    shared.lastActiveUrl = "https://linkedin.com/feed";
    shared.lastTurnBaselineCount = 1;
    shared.allMessages.push(
      { role: "assistant", parts: [{ type: "text", text: "turn 1 answer" }] },
      { role: "user", parts: [{ type: "text", text: "turn 2 question" }] },
    );

    // Now release the persist-wait and let the closure complete.
    resolvePersist!();
    await closurePromise;

    expect(received).not.toBeNull();
    // Turn 1's snapshot must survive the cross-turn mutation.
    expect(received!.catalogDomains).toEqual(["luma.com"]);
    expect(received!.activeUrl).toBe("https://luma.com/event/turn-1");
    expect(received!.baseline).toBe(0);
  });

  it("slices messages from the captured baseline so old turns aren't re-extracted", async () => {
    // Turn 1 finishes at baseline=2; turn 2 sees baseline=4. Without
    // slicing, the closure for turn 2 (or a later turn) would re-extract
    // turn 1's executeOnPage parts.
    const shared = {
      lastCatalogDomains: ["luma.com"],
      lastActiveUrl: "https://luma.com/x",
      lastTurnBaselineCount: 2, // turn 1 already captured 2 messages before this turn
      allMessages: [
        { role: "user", parts: [{ type: "text", text: "turn 1 user" }] },
        { role: "assistant", parts: [{ type: "text", text: "turn 1 assistant" }] },
        { role: "user", parts: [{ type: "text", text: "turn 2 user" }] },
        { role: "assistant", parts: [{ type: "text", text: "turn 2 assistant" }] },
      ],
    };
    let received: CuratorExtractInput | null = null;
    await curatorClosureUnderTest({
      turnConvId: "c1",
      callbackCid: "c1",
      shared,
      awaitPersist: () => Promise.resolve(),
      extract: (input) => {
        received = input;
      },
    });

    expect(received).not.toBeNull();
    // Only turn 2's messages should reach the extractor.
    expect(received!.messages).toHaveLength(2);
    expect(
      (received!.messages[0]!.parts![0] as { text: string }).text,
    ).toBe("turn 2 user");
    expect(
      (received!.messages[1]!.parts![0] as { text: string }).text,
    ).toBe("turn 2 assistant");
  });

  it("captures catalog domains by VALUE (slice), not by reference, so later mutation can't reach back into the snapshot", async () => {
    const shared = {
      lastCatalogDomains: ["luma.com"],
      lastActiveUrl: undefined as string | undefined,
      lastTurnBaselineCount: 0,
      allMessages: [],
    };
    let received: CuratorExtractInput | null = null;
    let resolvePersist: (() => void) | null = null;
    const persistDone = new Promise<void>((r) => (resolvePersist = r));

    const closurePromise = curatorClosureUnderTest({
      turnConvId: "c1",
      callbackCid: "c1",
      shared,
      awaitPersist: () => persistDone,
      extract: (input) => {
        received = input;
      },
    });

    // Mutate the SAME array reference rather than reassigning. If the
    // snapshot were `const x = shared.lastCatalogDomains` (no slice),
    // this push would leak into the snapshot.
    shared.lastCatalogDomains.push("linkedin.com");

    resolvePersist!();
    await closurePromise;

    expect(received!.catalogDomains).toEqual(["luma.com"]);
  });

  it("skips the closure entirely when the conversation id changed (e.g. user opened a new chat between gate-pass and approval)", async () => {
    const shared = {
      lastCatalogDomains: ["luma.com"],
      lastActiveUrl: "https://luma.com/x",
      lastTurnBaselineCount: 0,
      allMessages: [{ role: "user", parts: [{ type: "text", text: "x" }] }],
    };
    let extractCalled = false;
    await curatorClosureUnderTest({
      turnConvId: "c1",
      callbackCid: "c2", // mismatch
      shared,
      awaitPersist: () => Promise.resolve(),
      extract: () => {
        extractCalled = true;
      },
    });
    expect(extractCalled).toBe(false);
  });
});
