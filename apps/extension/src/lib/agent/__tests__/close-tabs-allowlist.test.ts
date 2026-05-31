import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../chat-db";

const CID = "conv-close-allow";

function installChromeStub() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: () => Promise.resolve({ ok: true }),
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: () => {}, removeListener: () => {} },
      get: (id: number) => Promise.resolve({ id, url: `https://x/${id}` }),
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(undefined),
    },
    storage: {
      local: {
        get: (key?: string | string[]) =>
          typeof key === "string"
            ? Promise.resolve({ [key]: store[key] })
            : Promise.resolve({ ...store }),
        set: (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    debugger: {
      onDetach: { addListener: () => {}, removeListener: () => {} },
      onEvent: { addListener: () => {}, removeListener: () => {} },
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
    },
  });
}

describe("closeTabs ownership-scoped always-allow", () => {
  beforeEach(async () => {
    installChromeStub();
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: CID, title: "t", spaceId: null, ownedGroupId: 1, ownedTabIds: [101, 102], createdAt: 0, updatedAt: 0,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    chatDb._resetForTests();
  });

  it("defaults to not-allowed (approval required)", async () => {
    const { isCloseTabsAlwaysAllowed } = await import("../agent-transport");
    expect(await isCloseTabsAlwaysAllowed()).toBe(false);
  });

  it("setCloseTabsAlwaysAllowed(true) flips the flag", async () => {
    const { isCloseTabsAlwaysAllowed, setCloseTabsAlwaysAllowed } = await import("../agent-transport");
    await setCloseTabsAlwaysAllowed(true);
    expect(await isCloseTabsAlwaysAllowed()).toBe(true);
  });

  it("auto-approves only when all targets are owned and flag is on", async () => {
    const { setCloseTabsAlwaysAllowed, shouldAutoApproveCloseTabs } = await import("../agent-transport");
    await setCloseTabsAlwaysAllowed(true);
    expect(await shouldAutoApproveCloseTabs(CID, { target: "group" })).toBe(true);
    expect(await shouldAutoApproveCloseTabs(CID, { target: "tabs", tabIds: [101] })).toBe(true);
  });

  it("does NOT auto-approve when a target is not owned, even with flag on", async () => {
    const { setCloseTabsAlwaysAllowed, shouldAutoApproveCloseTabs } = await import("../agent-transport");
    await setCloseTabsAlwaysAllowed(true);
    expect(await shouldAutoApproveCloseTabs(CID, { target: "tabs", tabIds: [999] })).toBe(false);
  });

  it("does NOT auto-approve when flag is off", async () => {
    const { shouldAutoApproveCloseTabs } = await import("../agent-transport");
    expect(await shouldAutoApproveCloseTabs(CID, { target: "group" })).toBe(false);
  });
});
