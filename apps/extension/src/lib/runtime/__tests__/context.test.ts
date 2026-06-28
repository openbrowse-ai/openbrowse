import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOffscreenContext,
  isRendererContext,
  isServiceWorkerContext,
} from "../context";

/**
 * Runtime-context guards must correctly identify the three Chrome
 * extension JS realms we care about:
 *   - service worker (background, no DOM)
 *   - offscreen document (DOM, but no chrome.debugger/tabs/scripting)
 *   - renderer extension page (sidepanel/home/newtab/popup)
 *
 * The guards are used to dispatch DOM-bound work (executeCode sandbox,
 * local-model inference) to the offscreen document when the agent loop
 * is hosted in the service worker.
 *
 * The Node-based vitest harness has neither `window`/`document` nor
 * `ServiceWorkerGlobalScope` by default, so each test stubs the relevant
 * globals to simulate the realm under test.
 */

describe("runtime context guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isServiceWorkerContext", () => {
    it("returns true when self is a ServiceWorkerGlobalScope", () => {
      class FakeServiceWorkerGlobalScope {}
      const fakeSelf = new FakeServiceWorkerGlobalScope();
      vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
      vi.stubGlobal("self", fakeSelf);
      vi.stubGlobal("window", undefined);
      vi.stubGlobal("document", undefined);

      expect(isServiceWorkerContext()).toBe(true);
    });

    it("returns false in a renderer (has window/document, no SWGS)", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", { URL: "chrome-extension://test/sidepanel.html" });

      expect(isServiceWorkerContext()).toBe(false);
    });

    it("returns false in the offscreen document", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", { URL: "chrome-extension://test/offscreen.html" });

      expect(isServiceWorkerContext()).toBe(false);
    });
  });

  describe("isOffscreenContext", () => {
    it("returns true when document.URL points at offscreen.html", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", { URL: "chrome-extension://abc/offscreen.html" });

      expect(isOffscreenContext()).toBe(true);
    });

    it("returns false for a non-offscreen extension page", () => {
      vi.stubGlobal("document", { URL: "chrome-extension://abc/sidepanel.html" });

      expect(isOffscreenContext()).toBe(false);
    });

    it("returns false in a service worker (no document)", () => {
      class FakeServiceWorkerGlobalScope {}
      vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
      vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());
      vi.stubGlobal("document", undefined);

      expect(isOffscreenContext()).toBe(false);
    });
  });

  describe("isRendererContext", () => {
    it("returns true for sidepanel.html", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("document", { URL: "chrome-extension://x/sidepanel.html" });

      expect(isRendererContext()).toBe(true);
    });

    it("returns true for home.html", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("document", { URL: "chrome-extension://x/home.html" });

      expect(isRendererContext()).toBe(true);
    });

    it("returns true for newtab.html", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("document", { URL: "chrome-extension://x/newtab.html" });

      expect(isRendererContext()).toBe(true);
    });

    it("returns false in the offscreen document", () => {
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("document", { URL: "chrome-extension://x/offscreen.html" });

      expect(isRendererContext()).toBe(false);
    });

    it("returns false in a service worker (no document)", () => {
      class FakeServiceWorkerGlobalScope {}
      vi.stubGlobal("ServiceWorkerGlobalScope", FakeServiceWorkerGlobalScope);
      vi.stubGlobal("self", new FakeServiceWorkerGlobalScope());
      vi.stubGlobal("document", undefined);

      expect(isRendererContext()).toBe(false);
    });
  });

  describe("guard exclusivity", () => {
    it("exactly one guard is true in each realm", () => {
      // Service worker
      class FakeSWGS {}
      vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
      vi.stubGlobal("self", new FakeSWGS());
      vi.stubGlobal("document", undefined);
      expect([
        isServiceWorkerContext(),
        isOffscreenContext(),
        isRendererContext(),
      ]).toEqual([true, false, false]);

      // Offscreen
      vi.unstubAllGlobals();
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("document", { URL: "chrome-extension://y/offscreen.html" });
      expect([
        isServiceWorkerContext(),
        isOffscreenContext(),
        isRendererContext(),
      ]).toEqual([false, true, false]);

      // Renderer
      vi.unstubAllGlobals();
      vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
      vi.stubGlobal("document", { URL: "chrome-extension://y/sidepanel.html" });
      expect([
        isServiceWorkerContext(),
        isOffscreenContext(),
        isRendererContext(),
      ]).toEqual([false, false, true]);
    });
  });
});
