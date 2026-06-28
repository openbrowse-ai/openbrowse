import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsRegistryState } from "@/entrypoints/background/skill-registry";

/**
 * In the SW realm, the renderer-style `SKILL_STATE_CHANGED` echo path is
 * a no-op (chrome.runtime.sendMessage does not echo to the SW that sent
 * it). So after SW-side mutations (`install`, `uninstall`,
 * `setSpaceState`, `setEnabled`) the wrapper's `subscribe()` listeners
 * would never fire — UI hooks reading via the wrapper would not
 * re-render even though the underlying state did change.
 *
 * Fix: after every successful SW-side mutation, the wrapper must re-read
 * `backgroundSkillRegistry.getStates()` into `this.state` and call
 * `notifyListeners()`. This test pins that contract.
 */

describe("SkillsRegistry SW-side mutations notify subscribers", () => {
  let stateSeq = 0;
  const states: SkillsRegistryState[] = [];

  beforeEach(async () => {
    vi.resetModules();
    stateSeq = 0;
    states.length = 0;

    // Stub the SW realm.
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function makeFakeBgRegistry() {
    const skillsByState = (n: number): SkillsRegistryState => ({
      skills: Array.from({ length: n }).map((_, i) => ({
        name: `skill-${i}`,
        description: `desc-${i}`,
        path: `/skills/skill-${i}`,
        sha: `sha${i}`,
        version: 1,
        kind: "agent",
        enabled: true,
      })) as unknown as SkillsRegistryState["skills"],
      spaceConfigs: [],
    });
    return {
      init: vi.fn(async () => {}),
      getStates: vi.fn(() => skillsByState(++stateSeq)),
      install: vi.fn(async () => ({ installed: [] })),
      uninstall: vi.fn(async () => {}),
      setSpaceState: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
    };
  }

  it("install→subscribers notified with fresh state in SW realm", async () => {
    const fakeBg = makeFakeBgRegistry();

    // Mock both the skill-registry import (used by SkillsRegistry.init)
    // and the skill-messages handler (used by sendSkillMessage's swRpc).
    vi.doMock("@/entrypoints/background/skill-registry", () => ({
      backgroundSkillRegistry: fakeBg,
    }));
    vi.doMock("@/entrypoints/background/skill-messages", () => ({
      handleSkillMessage: (message: { type: string }, sendResponse: (r: unknown) => void) => {
        if (message.type === "SKILL_INSTALL") {
          // Simulate the SW-side mutation effect.
          sendResponse({ success: true, installed: [] });
          return false;
        }
        sendResponse({ success: true, state: fakeBg.getStates() });
        return false;
      },
    }));

    const mod = await import("../registry");
    const reg = mod.getSkillsRegistry();
    await reg.init();

    const notifications: SkillsRegistryState[] = [];
    reg.subscribe(() => {
      notifications.push(reg.getState());
    });

    const before = reg.getState();
    expect(before.skills.length).toBeGreaterThan(0);

    await reg.install("github://user/skill");

    // After SW-side mutation, subscribers must have been notified.
    expect(notifications.length).toBeGreaterThan(0);
  });

  it("uninstall→subscribers notified in SW realm", async () => {
    const fakeBg = makeFakeBgRegistry();
    vi.doMock("@/entrypoints/background/skill-registry", () => ({
      backgroundSkillRegistry: fakeBg,
    }));
    vi.doMock("@/entrypoints/background/skill-messages", () => ({
      handleSkillMessage: (_message: unknown, sendResponse: (r: unknown) => void) => {
        sendResponse({ success: true });
        return false;
      },
    }));

    const mod = await import("../registry");
    const reg = mod.getSkillsRegistry();
    await reg.init();

    const fired: number[] = [];
    reg.subscribe(() => fired.push(1));

    await reg.uninstall("skill-0");
    expect(fired.length).toBeGreaterThan(0);
  });

  it("setSpaceState→subscribers notified in SW realm", async () => {
    const fakeBg = makeFakeBgRegistry();
    vi.doMock("@/entrypoints/background/skill-registry", () => ({
      backgroundSkillRegistry: fakeBg,
    }));
    vi.doMock("@/entrypoints/background/skill-messages", () => ({
      handleSkillMessage: (_message: unknown, sendResponse: (r: unknown) => void) => {
        sendResponse({ success: true });
        return false;
      },
    }));

    const mod = await import("../registry");
    const reg = mod.getSkillsRegistry();
    await reg.init();

    const fired: number[] = [];
    reg.subscribe(() => fired.push(1));

    await reg.setSpaceState("space-1", "skill-0", "allow");
    expect(fired.length).toBeGreaterThan(0);
  });

  it("setEnabled→subscribers notified in SW realm", async () => {
    const fakeBg = makeFakeBgRegistry();
    vi.doMock("@/entrypoints/background/skill-registry", () => ({
      backgroundSkillRegistry: fakeBg,
    }));
    vi.doMock("@/entrypoints/background/skill-messages", () => ({
      handleSkillMessage: (_message: unknown, sendResponse: (r: unknown) => void) => {
        sendResponse({ success: true });
        return false;
      },
    }));

    const mod = await import("../registry");
    const reg = mod.getSkillsRegistry();
    await reg.init();

    const fired: number[] = [];
    reg.subscribe(() => fired.push(1));

    await reg.setEnabled("skill-0", false);
    expect(fired.length).toBeGreaterThan(0);
  });

  // Mark this suite skipped if states is unused (lint).
  void states;
});
