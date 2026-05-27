/**
 * Verifies that `setAgentContext(newCid)` no longer wipes the in-memory
 * tab-handle map of the previously-active conversation. The bug being
 * prevented:
 *
 *   1. Conversation A's agent loop is mid-flight; tools have minted
 *      handles `t1`, `t2`, ... in A's handle map.
 *   2. The user navigates to conversation B; the UI calls
 *      `setAgentContext('B')`.
 *   3. A's still-running tool calls go to resolve `t1` — but the previous
 *      implementation had cleared A's handle map at step 2, so they fail
 *      with "Unknown tab handle".
 *
 * After the fix, `setAgentContext` retains all in-memory handle maps;
 * `tab-handles.ts`'s data structures are already keyed per conversation,
 * so coexistence is safe.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../chat-db";
import { setAgentContext } from "../agent-transport";
import {
  clearHandles,
  getOrCreateHandle,
  resolveHandle,
} from "../tab-handles";

const CONV_A = "conv-a";
const CONV_B = "conv-b";

async function seedConv(id: string) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: null,
    ownedTabIds: [],
    createdAt: 0,
    updatedAt: 0,
  });
}

describe("setAgentContext — handle-map preservation", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    setAgentContext(null);
    vi.unstubAllGlobals();
    // `loadHandlesForConversation` reads chrome.tabs.get during hydration;
    // stub it so the (fire-and-forget) hydration doesn't reject in tests.
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(async () => ({} as chrome.tabs.Tab)) },
    });
  });

  afterEach(() => {
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    setAgentContext(null);
    vi.unstubAllGlobals();
  });

  it("retains the previous conversation's in-memory handle map after a switch", async () => {
    await seedConv(CONV_A);
    await seedConv(CONV_B);

    setAgentContext(CONV_A);
    expect(getOrCreateHandle(CONV_A, 100)).toBe("t1");
    expect(resolveHandle(CONV_A, "t1")).toBe(100);

    // Switch to B mid-flight (as if user navigated). A's map must
    // survive — any tool call still in-flight for A needs to keep
    // resolving its handles.
    setAgentContext(CONV_B);
    expect(resolveHandle(CONV_A, "t1")).toBe(100);
  });

  it("does not leak handles between conversations after a switch", async () => {
    await seedConv(CONV_A);
    await seedConv(CONV_B);

    setAgentContext(CONV_A);
    getOrCreateHandle(CONV_A, 100); // A:t1 → 100

    setAgentContext(CONV_B);
    // B's map starts empty regardless of A's contents.
    expect(resolveHandle(CONV_B, "t1")).toBeUndefined();

    // Mint a handle in B; it must not collide with A's mapping.
    const bHandle = getOrCreateHandle(CONV_B, 200);
    expect(resolveHandle(CONV_B, bHandle)).toBe(200);
    expect(resolveHandle(CONV_A, "t1")).toBe(100); // A still intact.
  });

  it("repeated switches are idempotent w.r.t. handle preservation", async () => {
    await seedConv(CONV_A);
    await seedConv(CONV_B);

    setAgentContext(CONV_A);
    getOrCreateHandle(CONV_A, 100);
    getOrCreateHandle(CONV_A, 200);

    setAgentContext(CONV_B);
    setAgentContext(CONV_A);
    setAgentContext(CONV_B);
    setAgentContext(CONV_A);

    // After all the flipping, A's handles must still be there.
    expect(resolveHandle(CONV_A, "t1")).toBe(100);
    expect(resolveHandle(CONV_A, "t2")).toBe(200);
  });

  it("setting context to null also preserves prior maps", async () => {
    await seedConv(CONV_A);

    setAgentContext(CONV_A);
    getOrCreateHandle(CONV_A, 100);

    setAgentContext(null);
    expect(resolveHandle(CONV_A, "t1")).toBe(100);
  });
});
