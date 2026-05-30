import { describe, expect, it, vi } from "vitest";
import { bindSharedTab } from "../bind-shared-tab";

describe("bindSharedTab", () => {
  it("returns false and skips dispatch when tabId is null", async () => {
    const send = vi.fn(async () => undefined);
    const setTargetTabId = vi.fn();
    const out = await bindSharedTab(
      { conversationId: "c1", tabId: null },
      { send, setTargetTabId },
    );
    expect(out).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(setTargetTabId).not.toHaveBeenCalled();
  });

  it("dispatches BIND_ACTIVE_TAB_TO_CONVERSATION and pins the target on success", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const setTargetTabId = vi.fn();
    const out = await bindSharedTab(
      { conversationId: "c-abc", tabId: 42 },
      { send, setTargetTabId },
    );
    expect(out).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
      conversationId: "c-abc",
      tabId: 42,
    });
    expect(setTargetTabId).toHaveBeenCalledWith(42);
  });

  it("swallows send errors and does NOT pin the target", async () => {
    const send = vi.fn(async () => {
      throw new Error("background asleep");
    });
    const setTargetTabId = vi.fn();
    const out = await bindSharedTab(
      { conversationId: "c1", tabId: 7 },
      { send, setTargetTabId },
    );
    expect(out).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(setTargetTabId).not.toHaveBeenCalled();
  });

  it("treats a { ok: false } response as failure and does NOT pin the target", async () => {
    // The background handler catches its own errors and resolves with
    // { ok: false, error } rather than rejecting. bindSharedTab must
    // inspect the response so it doesn't pin a tab that was never
    // actually bound into the conversation's owned set.
    const send = vi.fn(async () => ({ ok: false, error: "bind failed" }));
    const setTargetTabId = vi.fn();
    const out = await bindSharedTab(
      { conversationId: "c1", tabId: 11 },
      { send, setTargetTabId },
    );
    expect(out).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(setTargetTabId).not.toHaveBeenCalled();
  });

  it("treats an undefined response as success (legacy fire-and-forget handlers)", async () => {
    const send = vi.fn(async () => undefined);
    const setTargetTabId = vi.fn();
    const out = await bindSharedTab(
      { conversationId: "c1", tabId: 12 },
      { send, setTargetTabId },
    );
    expect(out).toBe(true);
    expect(setTargetTabId).toHaveBeenCalledWith(12);
  });

  it("awaits the send before pinning so chatDb writes settle first", async () => {
    const order: string[] = [];
    const send = vi.fn(async () => {
      order.push("send-resolved");
    });
    const setTargetTabId = vi.fn(() => order.push("pin-target"));
    await bindSharedTab(
      { conversationId: "c1", tabId: 9 },
      { send, setTargetTabId },
    );
    expect(order).toEqual(["send-resolved", "pin-target"]);
  });
});
