/**
 * Vitest setup file. Provides a minimal `globalThis.chrome` stub so modules
 * that touch `chrome.runtime`, `chrome.tabs`, `chrome.storage`, etc. at
 * module-construction time can load in the Node test environment.
 *
 * Tests that need specific chrome behavior should `vi.stubGlobal("chrome", ...)`
 * at the start of the relevant test or beforeEach — the stub here is a
 * minimum-viable shim, not a full mock.
 */

if (typeof (globalThis as { chrome?: unknown }).chrome === "undefined") {
  const noop = () => {};
  const noopReturning = <T>(fallback: T) => () => fallback;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "test-extension",
      onMessage: {
        addListener: noop,
        removeListener: noop,
        hasListener: noopReturning(false),
      },
      sendMessage: () => Promise.resolve({ ok: true }),
      onStartup: { addListener: noop },
      onInstalled: { addListener: noop },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      lastError: undefined as unknown,
    },
    tabs: {
      onRemoved: { addListener: noop, removeListener: noop },
      onUpdated: { addListener: noop, removeListener: noop },
      onActivated: { addListener: noop, removeListener: noop },
      get: () => Promise.reject(new Error("chrome.tabs.get not stubbed")),
      query: () => Promise.resolve([] as never[]),
      sendMessage: () => Promise.resolve(undefined),
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      onChanged: { addListener: noop, removeListener: noop },
    },
    windows: {
      getCurrent: () => Promise.resolve({ id: 1 }),
    },
    debugger: {
      onDetach: { addListener: noop, removeListener: noop },
      onEvent: { addListener: noop, removeListener: noop },
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
    },
    scripting: {
      executeScript: () => Promise.resolve([]),
      insertCSS: () => Promise.resolve(),
    },
  };
}
