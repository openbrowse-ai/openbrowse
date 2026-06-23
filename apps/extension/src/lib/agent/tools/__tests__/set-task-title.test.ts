import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../../chat-db";
import type { ToolContext } from "../../driver";
import { setTaskTitleTool } from "../set-task-title";

const SUBAGENT_TITLE_UPDATED_EVENT = "openbrowse:subagent-title-updated";

// jsdom isn't enabled for this vitest project. Stub a minimal `window`
// (just an EventTarget) so the tool's CustomEvent dispatch has somewhere
// to land, and so addEventListener / dispatchEvent / CustomEvent work.
beforeAll(() => {
  if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
    const target = new EventTarget();
    (globalThis as Record<string, unknown>).window = target;
  }
});

const fakeDriver = {} as ToolContext["driver"];

const peerCtx = (overrides: Partial<ToolContext["session"]> = {}): ToolContext => ({
  driver: fakeDriver,
  session: {
    // Peer-isolated subagent: child conv id != parent conv id.
    conversationId: "child-1",
    spaceId: null,
    parent: { conversationId: "parent-1", depth: 1, toolCallId: "tc-abc" },
    ...overrides,
  },
});

describe("setTaskTitle tool", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: "child-1",
      title: "child",
      spaceId: null,
      createdAt: 100,
      updatedAt: 100,
      parentConversationId: "parent-1",
      subagentSlug: "explore",
      subagentStatus: "running",
      isolationProfile: "peer",
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("persists subagentTraceTitle on the child conversation", async () => {
    const out = await setTaskTitleTool.execute(
      { title: "Reading product pages" },
      peerCtx(),
    );
    expect(out).toEqual({ ok: true });
    const conv = await chatDb.getConversation("child-1");
    expect(conv?.subagentTraceTitle).toBe("Reading product pages");
  });

  it("dispatches openbrowse:subagent-title-updated keyed to parent's toolCallId", async () => {
    const handler = vi.fn();
    window.addEventListener(SUBAGENT_TITLE_UPDATED_EVENT, handler);
    await setTaskTitleTool.execute(
      { title: "Phase 2: comparing" },
      peerCtx(),
    );
    window.removeEventListener(SUBAGENT_TITLE_UPDATED_EVENT, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      toolCallId: "tc-abc",
      title: "Phase 2: comparing",
    });
  });

  it("returns an error when called outside a subagent context (no session.parent)", async () => {
    const out = await setTaskTitleTool.execute(
      { title: "anything" },
      {
        driver: fakeDriver,
        session: { conversationId: "parent-1", spaceId: null },
      },
    );
    expect(out).toEqual({
      ok: false,
      error: expect.stringMatching(/subagent/i),
    });
  });

  it("trims and rejects empty/oversize titles", async () => {
    const empty = await setTaskTitleTool.execute({ title: "   " }, peerCtx());
    expect(empty).toMatchObject({ ok: false });
    const huge = await setTaskTitleTool.execute(
      { title: "a".repeat(500) },
      peerCtx(),
    );
    expect(huge).toMatchObject({ ok: false });
  });
});
