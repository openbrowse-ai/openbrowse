import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../../chat-db";
import type { ToolContext } from "../../driver";
import { closeTabsTool } from "../close-tabs";

const sent: any[] = [];

function ctx(overrides: Partial<NonNullable<ToolContext["session"]>> = {}): ToolContext {
  return {
    driver: {} as ToolContext["driver"],
    session: {
      conversationId: "c1",
      resolveHandle: (h: string) => ({ t1: 101, t2: 102 } as Record<string, number>)[h],
      ...overrides,
    },
  };
}

beforeEach(async () => {
  sent.length = 0;
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
  await chatDb.createConversation({
    id: "c1", title: "t", spaceId: null, ownedGroupId: 5, ownedTabIds: [101, 102], createdAt: 0, updatedAt: 0,
  });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      sendMessage: (msg: any) => {
        sent.push(msg);
        return Promise.resolve({
          ok: true,
          undo: {
            action: "reopen",
            tabs: (msg.tabIds as number[]).map((_id, i) => ({
              url: `https://tab-${i}`,
              windowId: 1,
              pinned: false,
            })),
          },
        });
      },
      lastError: undefined,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  chatDb._resetForTests();
});

describe("closeTabs tool", () => {
  it("target:'group' closes all owned tab ids", async () => {
    const res = await closeTabsTool.execute({ target: "group" }, ctx());
    expect(sent[0].type).toBe("CLOSE_AGENT_TABS");
    expect(sent[0].conversationId).toBe("c1");
    expect(sent[0].tabIds.sort()).toEqual([101, 102]);
    expect(res.closed).toBe(2);
  });

  it("target:'tabs' resolves handles to ids", async () => {
    const res = await closeTabsTool.execute({ target: "tabs", handles: ["t1"] }, ctx());
    expect(sent[0].tabIds).toEqual([101]);
    expect(res.closed).toBe(1);
  });

  it("throws when a handle does not resolve", async () => {
    await expect(
      closeTabsTool.execute({ target: "tabs", handles: ["t9"] }, ctx()),
    ).rejects.toThrow(/t9/);
  });

  it("returns closed:0 with a note when group is empty", async () => {
    await chatDb.updateConversation("c1", { ownedTabIds: [], ownedGroupId: null });
    const res = await closeTabsTool.execute({ target: "group" }, ctx());
    expect(res.closed).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("reports closed count from the undo payload, not the requested count", async () => {
    // Background helper tolerates already-gone tabs and only includes
    // really-removed tabs in undo.tabs. We request a group close of 2 owned
    // tabs but the helper reports only 1 actually closed.
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test",
        sendMessage: (msg: any) => {
          sent.push(msg);
          return Promise.resolve({
            ok: true,
            undo: {
              action: "reopen",
              tabs: [{ url: "https://a", windowId: 1, pinned: false }],
            },
          });
        },
        lastError: undefined,
      },
    });
    const res = await closeTabsTool.execute({ target: "group" }, ctx());
    expect(sent[0].tabIds.sort()).toEqual([101, 102]);
    expect(res.closed).toBe(1);
  });

  it("declares approval required", () => {
    expect(closeTabsTool.approval?.required).toBe(true);
  });
});
