import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Module-graph regression: the agent loop is being moved into the MV3
 * service worker, which has no `window` and no `document`. Any module that
 * touches DOM globals at module-construction time (top-level statements,
 * default parameter evaluation, eager initializers) would crash the SW at
 * import.
 *
 * This test stubs out `window` and `document` to `undefined` and then
 * `await import(...)`s the agent-transport entry. If the import resolves,
 * every transitively imported module is SW-import-clean. If a regression
 * lands a module-scope DOM access, this test fails with the actual
 * `ReferenceError`/`TypeError` and the file responsible appears in the
 * stack.
 *
 * Note: this is NOT a guarantee that the agent code RUNS correctly in the
 * SW — that requires the runtime-context dispatch (executeCode sandbox to
 * offscreen, local models to offscreen, etc.). It only guarantees that the
 * import graph loads cleanly.
 */
describe("agent transport SW-import graph", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("agent-transport loads with window/document undefined", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    // Simulate the service worker realm: install a ServiceWorkerGlobalScope
    // so any module that decides what to do at top level via the runtime
    // guards lands on the SW branch.
    class FakeServiceWorkerGlobalScope {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
    vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());

    // Re-import fresh so any cached renderer-context evaluation does not
    // mask the regression.
    vi.resetModules();

    await expect(import("@/lib/agent/agent-transport")).resolves.toBeDefined();
  });

  it("tool index loads with window/document undefined", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeServiceWorkerGlobalScope {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
    vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());
    vi.resetModules();

    await expect(import("@/lib/agent/tools/index")).resolves.toBeDefined();
  });

  it("cdp-session loads with window/document undefined", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeServiceWorkerGlobalScope {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
    vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());
    vi.resetModules();

    await expect(import("@/lib/agent/cdp-session")).resolves.toBeDefined();
  });

  it("compacting-transport loads with window/document undefined", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeServiceWorkerGlobalScope {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
    vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());
    vi.resetModules();

    await expect(import("@/lib/agent/compacting-transport")).resolves.toBeDefined();
  });

  it("agent-host bootstrap loads with window/document undefined", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeServiceWorkerGlobalScope {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
    vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());
    vi.resetModules();

    await expect(
      import("@/entrypoints/background/agent-host/bootstrap"),
    ).resolves.toBeDefined();
  });
});
