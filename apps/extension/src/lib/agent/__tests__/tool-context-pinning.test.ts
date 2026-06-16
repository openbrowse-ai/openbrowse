/**
 * Verifies the per-tool-call conversationId pinning contract that
 * `buildExtensionToolContext(pinnedConversationId)` is supposed to
 * provide. The bug being prevented:
 *
 *   1. Tool call begins for conversation A.
 *   2. Inside the tool's `execute` (between awaits), the user navigates
 *      to conversation B and the UI calls `setAgentContext('B')`.
 *   3. The tool's `ctx.session.setTodos(...)` is supposed to write to A,
 *      not B.
 *
 * Pre-fix, session helpers read `getAgentContext().conversationId`
 * lazily on every call — so step 3 silently misrouted to B. After the
 * fix, the cid is captured at context construction (i.e. at
 * tool-call entry inside `toSDKTool.execute`) and never re-read.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../chat-db";
import {
  buildExtensionToolContext,
  setAgentContext,
} from "../agent-transport";
import {
  clearHandles,
  getOrCreateHandle,
} from "../tab-handles";
import { tabRegistry, type LogicalTabId } from "../tab-registry";
import { todoWriteTool } from "../tools/todowrite";

const CONV_A = "conv-a";
const CONV_B = "conv-b";

async function seedConv(
  id: string,
  opts: {
    ownedLtids?: LogicalTabId[];
    ownedGroupId?: number | null;
    todos?: import("../../types").TodoItem[];
  } = {},
) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: null,
    ownedLtids: opts.ownedLtids ?? [],
    ownedGroupId: opts.ownedGroupId ?? null,
    todos: opts.todos ?? [],
    createdAt: 0,
    updatedAt: 0,
  });
}

/** Mint an ltid for a fake ctid via the registry. */
function ltidFor(ctid: number): LogicalTabId {
  return tabRegistry.registerExisting(ctid);
}

describe("buildExtensionToolContext (per-call cid pinning)", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    setAgentContext(null);
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
    // Tests that touch tab-binding helpers need a chrome stub so the
    // helper's `chrome.runtime.sendMessage` doesn't blow up.
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    setAgentContext(null);
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
  });

  describe("session.conversationId", () => {
    it("is the literal pinned cid (not a getter that reads global)", () => {
      const ctx = buildExtensionToolContext(CONV_A);
      expect(ctx.session?.conversationId).toBe(CONV_A);

      // Flipping the global must not change the pinned value.
      setAgentContext(CONV_B);
      expect(ctx.session?.conversationId).toBe(CONV_A);
    });

    it("is null when constructed with null", () => {
      const ctx = buildExtensionToolContext(null);
      expect(ctx.session?.conversationId).toBeNull();
    });
  });

  describe("getTodos / setTodos", () => {
    it("getTodos reads from pinned cid even after a mid-flight switch", async () => {
      await seedConv(CONV_A, {
        todos: [
          {
            id: "t-A1",
            content: "A's task",
            status: "pending",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });
      await seedConv(CONV_B, {
        todos: [
          {
            id: "t-B1",
            content: "B's task",
            status: "pending",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });

      const ctx = buildExtensionToolContext(CONV_A);
      // Switch globally between context construction and the read; must
      // not affect the pinned read.
      setAgentContext(CONV_B);

      const todos = await ctx.session!.getTodos!();
      expect(todos).toHaveLength(1);
      expect(todos[0].id).toBe("t-A1");
    });

    it("setTodos writes to pinned cid even after a mid-flight switch", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);

      const ctx = buildExtensionToolContext(CONV_A);
      setAgentContext(CONV_B);

      const newTodos: import("../../types").TodoItem[] = [
        {
          id: "new-1",
          content: "Pinned write",
          status: "in_progress",
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      await ctx.session!.setTodos!(newTodos);

      const convA = await chatDb.getConversation(CONV_A);
      const convB = await chatDb.getConversation(CONV_B);
      expect(convA?.todos?.[0]?.id).toBe("new-1");
      // B must remain untouched.
      expect(convB?.todos ?? []).toEqual([]);
    });

    it("end-to-end via todoWriteTool.execute survives a mid-await switch", async () => {
      await seedConv(CONV_A, {
        todos: [
          {
            id: "existing-A",
            content: "Existing",
            status: "pending",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });
      await seedConv(CONV_B);

      const ctx = buildExtensionToolContext(CONV_A);

      // Wrap session.getTodos so we can flip the global mid-execute,
      // simulating the user navigating to a different conversation
      // between the tool's read and write.
      const originalGetTodos = ctx.session!.getTodos!.bind(ctx.session);
      ctx.session!.getTodos = async () => {
        const result = await originalGetTodos();
        setAgentContext(CONV_B);
        return result;
      };

      const result = await todoWriteTool.execute(
        {
          todos: [
            {
              content: "New pinned task",
              status: "in_progress",
              priority: "high",
            },
          ],
        },
        ctx,
      );

      expect(result).toEqual({ saved: true });
      const convA = await chatDb.getConversation(CONV_A);
      const convB = await chatDb.getConversation(CONV_B);
      expect(convA?.todos).toHaveLength(1);
      expect(convA?.todos?.[0]?.content).toBe("New pinned task");
      expect(convB?.todos ?? []).toEqual([]);
    });

    it("getTodos returns [] when pinned cid is null", async () => {
      const ctx = buildExtensionToolContext(null);
      expect(await ctx.session!.getTodos!()).toEqual([]);
    });

    it("setTodos is a no-op when pinned cid is null", async () => {
      await seedConv(CONV_A);
      const ctx = buildExtensionToolContext(null);
      await ctx.session!.setTodos!([
        {
          id: "x",
          content: "x",
          status: "pending",
          createdAt: 0,
          updatedAt: 0,
        },
      ]);
      const convA = await chatDb.getConversation(CONV_A);
      expect(convA?.todos ?? []).toEqual([]);
    });
  });

  describe("isAgentOwnedTab / hasOwnedTabGroup", () => {
    it("isAgentOwnedTab targets pinned cid", async () => {
      // Mint ltids for two synthetic ctids and seed each conversation
      // with its own ltid. isAgentOwnedTab takes a chrome ctid (the
      // session API surface predates the migration); internally it
      // resolves ctid → ltid via the registry to test the conversation's
      // ownedLtids set.
      const ltid42 = ltidFor(42);
      const ltid99 = ltidFor(99);
      await seedConv(CONV_A, { ownedLtids: [ltid42] });
      await seedConv(CONV_B, { ownedLtids: [ltid99] });

      const ctxA = buildExtensionToolContext(CONV_A);
      setAgentContext(CONV_B);

      expect(await ctxA.session!.isAgentOwnedTab!(42)).toBe(true);
      expect(await ctxA.session!.isAgentOwnedTab!(99)).toBe(false);
    });

    it("hasOwnedTabGroup targets pinned cid", async () => {
      await seedConv(CONV_A, { ownedGroupId: 7 });
      await seedConv(CONV_B, { ownedGroupId: null });

      const ctxA = buildExtensionToolContext(CONV_A);
      const ctxB = buildExtensionToolContext(CONV_B);

      // Flip global to be sure neither reads from it.
      setAgentContext(CONV_A);
      expect(await ctxB.session!.hasOwnedTabGroup!()).toBe(false);
      setAgentContext(CONV_B);
      expect(await ctxA.session!.hasOwnedTabGroup!()).toBe(true);
    });

    it("returns false when pinned cid is null", async () => {
      const ctx = buildExtensionToolContext(null);
      expect(await ctx.session!.isAgentOwnedTab!(1)).toBe(false);
      expect(await ctx.session!.hasOwnedTabGroup!()).toBe(false);
    });
  });

  describe("getOrCreateHandle / resolveHandle", () => {
    it("getOrCreateHandle uses pinned cid's handle map", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);

      // Pre-populate B's handle map; A's is empty. The direct
      // tab-handles `getOrCreateHandle` takes an ltid (string), so we
      // mint one for the synthetic ctid 500 first.
      getOrCreateHandle(CONV_B, ltidFor(500));

      const ctxA = buildExtensionToolContext(CONV_A);
      // Even with global flipped to B, ctxA's helper must mint into A.
      setAgentContext(CONV_B);
      // The session helper accepts a ctid (number) and routes through
      // the registry to mint/recover an ltid.
      const aHandle = ctxA.session!.getOrCreateHandle!(123);
      expect(aHandle).toBe("t1");
      // B's map is unchanged for tab 123.
      const ctxB = buildExtensionToolContext(CONV_B);
      const bHandle = ctxB.session!.getOrCreateHandle!(123);
      // tab 123 is new for B → first available counter slot.
      expect(bHandle).toBe("t2");
    });

    it("resolveHandle uses pinned cid's handle map", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);
      const ltid100 = ltidFor(100);
      const ltid200 = ltidFor(200);
      getOrCreateHandle(CONV_A, ltid100); // A:t1 → ltid100
      getOrCreateHandle(CONV_B, ltid200); // B:t1 → ltid200

      const ctxA = buildExtensionToolContext(CONV_A);
      setAgentContext(CONV_B);

      // resolveHandle returns the LogicalTabId, not the ctid.
      expect(ctxA.session!.resolveHandle!("t1")).toBe(ltid100);
    });

    it("falls back to t<id> when pinned cid is null", () => {
      const ctx = buildExtensionToolContext(null);
      expect(ctx.session!.getOrCreateHandle!(7)).toBe("t7");
      expect(ctx.session!.resolveHandle!("t1")).toBeUndefined();
    });
  });
});
