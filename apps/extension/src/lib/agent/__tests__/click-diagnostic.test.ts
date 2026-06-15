import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClickDiagnostic } from "../click-diagnostic";
import type { BrowserDriver } from "../driver";

/**
 * Test the click diagnostic's classifier. The diagnostic logs a single tag
 * per click; the tag drives whether engineers should investigate. Three
 * tags are functionally distinct:
 *
 *   ok / ok-retarget   — click landed on a page element. ok-retarget means
 *                         we saw the CUA-working-host as `top` but it's a
 *                         shadow-DOM-retargeted hit (chain[1+] is real
 *                         page content) and the shield is in passthrough.
 *                         Emitted at console.debug — quiet by default.
 *   OVERLAY-INTERCEPT  — an OpenBrowse overlay is genuinely eating the
 *                         click (shield not in passthrough, search backdrop
 *                         mounted, etc.). Emitted at console.warn — loud.
 *   OFF-VIEWPORT       — coords outside the visible viewport. console.warn.
 *
 * Pre-fix, the classifier used to flag every successful click as
 * OVERLAY-INTERCEPT (because elementsFromPoint retargets shadow hits to
 * the host, and the host string matches the overlay regex). This file
 * regression-tests the post-fix classifier.
 */

const TAB_ID = 1;
const URL = "https://example.com";

function makeDriver(diagResponse: unknown): BrowserDriver {
  return {
    sendToContentScript: async () => diagResponse,
  } as unknown as BrowserDriver;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  debugSpy.mockRestore();
  infoSpy.mockRestore();
});

/** Extract the single string argument logged via spy.calls (`[message, raw]`). */
function loggedMessage(spy: ReturnType<typeof vi.spyOn>): string {
  const call = spy.mock.calls.at(-1);
  expect(call).toBeDefined();
  return String(call?.[0] ?? "");
}

describe("runClickDiagnostic — benign retargeted-host classification (H2 regression)", () => {
  it("tags as ok-retarget when top is the working host but shieldPE=none and chain has page elements", async () => {
    // The exact shape every successful agent click produces under the
    // post-fix overlay CSS: elementsFromPoint retargets the shadow hit to
    // the host, so `top` is the host id. With pe:none on .ob-cua-root and
    // .ob-cua-shield.ob-passthrough, the click DOES land on the real page
    // element (visible in chain[1+]). Pre-fix this was flagged as
    // OVERLAY-INTERCEPT — false positive on every click.
    const driver = makeDriver({
      ok: true,
      top: "div#openbrowse-cua-working-host",
      chain: [
        "div#openbrowse-cua-working-host",
        "button.faq-toggle",
        "li",
        "ul",
      ],
      shieldComputedPointerEvents: "none",
      cuaWorkingHostMounted: true,
      cuaAgentActing: true,
      searchOverlayMounted: false,
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    await runClickDiagnostic(driver, TAB_ID, "test", 100, 200);

    expect(warnSpy).not.toHaveBeenCalled(); // critical: no false-positive warn
    expect(debugSpy).toHaveBeenCalled();
    expect(loggedMessage(debugSpy)).toContain("ok-retarget");
  });

  it("STILL flags OVERLAY-INTERCEPT when shield is pe:auto (real interception)", async () => {
    // shieldPE != "none" means the toggle didn't propagate; the shield is
    // a hit-test target and the click really is being eaten. This is the
    // shape that surfaced the original bug.
    const driver = makeDriver({
      ok: true,
      top: "div#openbrowse-cua-working-host",
      chain: ["div#openbrowse-cua-working-host", "button.real-page-button"],
      shieldComputedPointerEvents: "auto",
      cuaWorkingHostMounted: true,
      cuaAgentActing: false,
      searchOverlayMounted: false,
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    await runClickDiagnostic(driver, TAB_ID, "test", 100, 200);

    expect(warnSpy).toHaveBeenCalled();
    expect(loggedMessage(warnSpy)).toContain("OVERLAY-INTERCEPT");
  });

  it("flags OVERLAY-INTERCEPT when chain has no page elements behind the host (only OB elements)", async () => {
    // Defensive: if for any reason there's nothing behind the host, the
    // click landed on the host itself (or its shadow children) — that IS
    // an interception even when shieldPE=none.
    const driver = makeDriver({
      ok: true,
      top: "div#openbrowse-cua-working-host",
      chain: [
        "div#openbrowse-cua-working-host",
        "div#openbrowse-overlay-host", // search overlay also up
      ],
      shieldComputedPointerEvents: "none",
      cuaWorkingHostMounted: true,
      cuaAgentActing: true,
      searchOverlayMounted: true,
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    await runClickDiagnostic(driver, TAB_ID, "test", 100, 200);

    expect(warnSpy).toHaveBeenCalled();
    expect(loggedMessage(warnSpy)).toContain("OVERLAY-INTERCEPT");
  });

  it("flags OVERLAY-INTERCEPT when search overlay is mounted, regardless of host top shape", async () => {
    // Search backdrop has pe:auto and IS a real catcher. Even if the top
    // happens to be the CUA host (interleaved overlays), search-overlay-
    // mounted is enough.
    const driver = makeDriver({
      ok: true,
      top: "div#openbrowse-cua-working-host",
      chain: ["div#openbrowse-cua-working-host", "main"],
      shieldComputedPointerEvents: "none",
      cuaWorkingHostMounted: true,
      cuaAgentActing: true,
      searchOverlayMounted: true, // ← the killer
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    await runClickDiagnostic(driver, TAB_ID, "test", 100, 200);

    expect(warnSpy).toHaveBeenCalled();
    expect(loggedMessage(warnSpy)).toContain("OVERLAY-INTERCEPT");
  });

  it("does NOT flag the click ripple host as an interception (.ob-ripple-* is pe:none on its host, never blocks)", async () => {
    // L5 regression: a click that fires within ~850ms of a previous click
    // can see the still-fading ripple at the top. The ripple host's host
    // element has `pointer-events:none` set inline, so it never intercepts
    // CDP input — the diagnostic must not flag it.
    const driver = makeDriver({
      ok: true,
      top: "div.ob-ripple-burst",
      chain: ["div.ob-ripple-burst", "button.real-page-button"],
      shieldComputedPointerEvents: "none",
      cuaWorkingHostMounted: true,
      cuaAgentActing: true,
      searchOverlayMounted: false,
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    await runClickDiagnostic(driver, TAB_ID, "test", 100, 200);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
    expect(loggedMessage(debugSpy)).toContain(" ok ");
  });

  it("tags OFF-VIEWPORT when coords are outside innerWidth/Height", async () => {
    const driver = makeDriver({
      ok: true,
      top: "html",
      chain: ["html"],
      shieldComputedPointerEvents: "none",
      cuaWorkingHostMounted: true,
      cuaAgentActing: true,
      searchOverlayMounted: false,
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    // y=900 > innerHeight=800
    await runClickDiagnostic(driver, TAB_ID, "test", 640, 900);

    expect(warnSpy).toHaveBeenCalled();
    expect(loggedMessage(warnSpy)).toContain("OFF-VIEWPORT");
  });

  it("tags ok and emits at console.debug when top is a real page element", async () => {
    const driver = makeDriver({
      ok: true,
      top: "button#submit",
      chain: ["button#submit", "form", "main"],
      shieldComputedPointerEvents: "none",
      cuaWorkingHostMounted: false,
      cuaAgentActing: false,
      searchOverlayMounted: false,
      innerWidth: 1280,
      innerHeight: 800,
      url: URL,
    });

    await runClickDiagnostic(driver, TAB_ID, "test", 100, 200);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
    expect(loggedMessage(debugSpy)).toContain(" ok ");
  });
});
