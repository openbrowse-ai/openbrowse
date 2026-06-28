import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `sendSkillMessage` must NOT use `chrome.runtime.sendMessage` when
 * called from the service worker realm — the SW cannot deliver
 * messages to its own listeners, so the call would reject with
 * "Could not establish connection. Receiving end does not exist."
 * (which surfaces in the chat UI as "The message port closed before a
 * response was received.").
 *
 * Instead, the SW realm must invoke `handleSkillMessage` in-process.
 * Renderer realms continue to use `chrome.runtime.sendMessage`
 * unchanged.
 */

describe("sendSkillMessage realm dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("in renderer context, calls chrome.runtime.sendMessage", async () => {
    vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
    vi.stubGlobal("document", {
      URL: "chrome-extension://test/sidepanel.html",
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ success: true, state: { skills: [], spaceConfigs: [] } });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    vi.resetModules();
    const { sendSkillMessage } = await import("../messages");
    const res = await sendSkillMessage({ type: "SKILL_INIT" });

    expect(sendMessage).toHaveBeenCalledWith({ type: "SKILL_INIT" });
    expect(res).toMatchObject({ success: true });
  });

  it("in SW context, does NOT call chrome.runtime.sendMessage and invokes the handler in-process", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    // Mock the SW-side handler module — we don't want to drag the real
    // backgroundSkillRegistry (which touches OPFS) into this unit test.
    vi.doMock("@/entrypoints/background/skill-messages", () => ({
      handleSkillMessage: vi.fn(
        (msg: { type: string }, sendResponse: (r: unknown) => void) => {
          sendResponse({
            success: true,
            state: { skills: [{ name: msg.type }], spaceConfigs: [] },
          });
        },
      ),
    }));

    vi.resetModules();
    const { sendSkillMessage } = await import("../messages");
    const res = (await sendSkillMessage({ type: "SKILL_INIT" })) as {
      success: boolean;
      state: { skills: Array<{ name: string }> };
    };

    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.state.skills).toEqual([{ name: "SKILL_INIT" }]);
  });

  it("in SW context, propagates handler errors as thrown errors", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    vi.doMock("@/entrypoints/background/skill-messages", () => ({
      handleSkillMessage: (
        _msg: unknown,
        sendResponse: (r: unknown) => void,
      ) => {
        sendResponse({ success: false, error: "missing-skill" });
      },
    }));

    vi.resetModules();
    const { sendSkillMessage } = await import("../messages");
    await expect(
      sendSkillMessage({ type: "SKILL_GET_BODY", name: "x" }),
    ).rejects.toThrow(/missing-skill/);
  });
});
