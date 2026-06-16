import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCloseAgentTabs } from "@/components/cowork/request-close-agent-tabs";
import { tabRegistry } from "@/lib/agent/tab-registry";

const sent: any[] = [];
let ltid101: string;
let ltid102: string;

beforeEach(() => {
  sent.length = 0;
  tabRegistry.__resetForTests!();
  // Mint ltids for the synthetic ctids the test uses; requestCloseAgentTabs
  // takes ctids (caller convenience) and translates internally to ltids.
  ltid101 = tabRegistry.registerExisting(101);
  ltid102 = tabRegistry.registerExisting(102);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      sendMessage: (msg: any) => {
        sent.push(msg);
        return Promise.resolve({ ok: true, undo: { action: "reopen", tabs: [] } });
      },
      lastError: undefined,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  tabRegistry.__resetForTests!();
});

describe("requestCloseAgentTabs", () => {
  it("sends CLOSE_AGENT_TABS with conversationId + ltids (translated from ctids)", async () => {
    const res = await requestCloseAgentTabs("c1", [101, 102]);
    expect(sent[0]).toEqual({
      type: "CLOSE_AGENT_TABS",
      conversationId: "c1",
      ltids: [ltid101, ltid102],
    });
    expect(res.ok).toBe(true);
  });

  it("no-ops (does not send) when tabIds is empty", async () => {
    const res = await requestCloseAgentTabs("c1", []);
    expect(sent.length).toBe(0);
    expect(res.ok).toBe(false);
  });

  it("no-ops when conversationId is empty", async () => {
    const res = await requestCloseAgentTabs("", [101]);
    expect(sent.length).toBe(0);
    expect(res.ok).toBe(false);
  });

  it("returns ok:false when the background reports failure", async () => {
    (chrome.runtime as { sendMessage: unknown }).sendMessage = () =>
      Promise.resolve({ ok: false, error: "boom" });
    const res = await requestCloseAgentTabs("c1", [101]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });

  it("returns ok:false when sendMessage throws", async () => {
    (chrome.runtime as { sendMessage: unknown }).sendMessage = () =>
      Promise.reject(new Error("no receiver"));
    const res = await requestCloseAgentTabs("c1", [101]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no receiver");
  });
});
