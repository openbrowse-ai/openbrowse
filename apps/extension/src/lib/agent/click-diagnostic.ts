import type { BrowserDriver, TabId } from "./driver";

/**
 * Toggle the CUA "working on this page" overlay's input shield to
 * pointer-events:none (when `on` is true) or back to pointer-events:auto.
 *
 * Critical for ANY tool that dispatches CDP `Input.dispatchMouseEvent`:
 * the shield is mounted whenever an agent is running (`notifyAgentStatus`
 * is called from agent-transport for the MAIN agent and from cua-loop for
 * the CUA subagent), and CDP-dispatched events are trusted browser-level
 * input events that respect DOM hit-testing — so they hit the shield first
 * and never reach the page element. Wrap every CDP click/type/scroll with:
 *
 *     await setShieldPassthrough(driver, tabId, true);
 *     try { await driver.sendCommand(tabId, "Input.dispatchMouseEvent", …); }
 *     finally { await setShieldPassthrough(driver, tabId, false); }
 *
 * No-op when no shield is present (no content script / overlay not mounted).
 * Logs a warning if the content-script round-trip fails: that means the
 * shield (if mounted) stays in its previous state — one of the click-eaten
 * failure modes.
 */
export async function setShieldPassthrough(
  driver: BrowserDriver,
  tabId: TabId,
  on: boolean,
): Promise<void> {
  try {
    await driver.sendToContentScript(tabId, {
      type: "CHAT_CUA_INPUT_PASSTHROUGH",
      on,
    });
  } catch (err) {
    console.warn(
      `[click-shield] setShieldPassthrough(${on}) tab ${String(tabId)} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Forensic click-time diagnostic shared by both click paths:
 *   - the CUA subagent (cua/cua-loop.ts → executeAndShoot)
 *   - the main agent's `clickElement` tool (tools/click-element.ts)
 *
 * Asks the content script (via `CHAT_CUA_DIAG_HIT_TEST`) what's actually at
 * the click point and what state the OpenBrowse overlays are in. Result is
 * logged to the service-worker console with a single status tag plus all
 * key fields INLINED into the message string — this lets a developer read
 * the log without expanding the `Object` summary the browser collapses by
 * default.
 *
 * **Timing matters.** Both click paths run this BEFORE dispatch, INSIDE
 * the `setShieldPassthrough(true)` window. Earlier we ran it AFTER
 * `setShieldPassthrough(false)`, which produced a guaranteed false-positive
 * `OVERLAY-INTERCEPT` every single click (the shield was naturally back
 * to `pointer-events: auto` by then). At the in-window moment this is
 * called, the shield should have `pointer-events: none` and the topmost
 * element should be the real page element.
 *
 * Read-only, fire-and-forget — never throws, never blocks. Output goes only
 * to the console; nothing is surfaced to the model.
 *
 * Status tags:
 *   `OVERLAY-INTERCEPT` — an OpenBrowse overlay (CUA shield, search backdrop,
 *      working-host) is the topmost element at the click point, OR the search
 *      overlay is mounted at all. With our pre-dispatch timing this is a
 *      REAL click-eater: the shield is still hit-testable despite the
 *      passthrough class being added (toggle didn't propagate, or CSS not
 *      yet applied). Look at `shieldPE` to confirm.
 *
 *      Important nuance: `top=div#openbrowse-cua-working-host` is the
 *      retargeted form of "something inside the working-host's shadow DOM
 *      was hit". `document.elementsFromPoint` retargets shadow-DOM hits to
 *      the host when called from outside the shadow tree. If you see this
 *      with `shieldPE=none` and the chain[1+] are page elements (no `ob-`
 *      prefix), the actual catcher is a sibling of the shield inside the
 *      shadow DOM that has implicit `pointer-events: auto` — historically
 *      this was `.ob-cua-root` (fixed: pe:none added to the root). If
 *      this regresses with `shieldPE=none`, look at the shadow tree's
 *      computed PE on every element, not just the shield.
 *   `OFF-VIEWPORT`     — the click coordinate is outside the viewport.
 *      Suggests a scroll-needed scenario (CDP only hits the visible viewport)
 *      or a DPR/zoom/coord-normalization bug.
 *   `ok`               — top element looks plausible. Combine with the
 *      `top` and `chain` fields to confirm the intended element was hit.
 *
 * The two bad-shape tags are logged at `console.warn`; `ok` is logged at
 * `console.info` so all dispatch-side logs are visible at DevTools' default
 * log level (`console.debug` is filtered out unless Verbose is enabled).
 */
export interface ClickDiagnosticResponse {
  ok: boolean;
  top?: string;
  chain?: string[];
  cuaWorkingHostMounted?: boolean;
  shieldComputedPointerEvents?: string | null;
  cuaAgentActing?: boolean;
  searchOverlayMounted?: boolean;
  devicePixelRatio?: number;
  innerWidth?: number;
  innerHeight?: number;
  visualViewportScale?: number | null;
  scrollX?: number;
  scrollY?: number;
  url?: string;
  error?: string;
}

/** Truthy when the diagnostic's `top` element is one of OpenBrowse's overlay
 *  hosts/children that COULD plausibly intercept a click. Recognizes:
 *   - `div#openbrowse-cua-working-host` (host id — see classification below)
 *   - `div#openbrowse-overlay-host`     (search overlay host — its backdrop
 *     `.sb-backdrop` has pe:auto and DOES intercept)
 *   - any element whose first class is `.ob-cua-…`     (working-overlay shadow
 *     children: `.ob-cua-shield` without `.ob-passthrough` is the canonical
 *     click-eater)
 *   - any element whose first class is `.sb-…`         (search backdrop)
 *
 *  Intentionally does NOT match `.ob-ripple-*` — the click-ripple host is
 *  `pointer-events: none` (set on its host element directly via
 *  `host.style.cssText`), so it never intercepts trusted CDP input. Without
 *  this exclusion, every click within ~850ms of a previous click would be
 *  flagged OVERLAY-INTERCEPT because elementsFromPoint sees the still-fading
 *  ripple at the top.
 *
 *  Also intentionally does NOT match `.ob-` more broadly — that's a footgun:
 *  a future host using the prefix would silently get flagged. Add specific
 *  matchers as new overlay hosts are introduced. */
function looksLikeOpenBrowseOverlay(top: string): boolean {
  return (
    /^div#openbrowse-cua-working-host\b/.test(top) ||
    /^div#openbrowse-overlay-host\b/.test(top) ||
    /\.ob-cua-/.test(top) ||
    /\.sb-/.test(top)
  );
}

/** Recognize the benign case where `top` is just the CUA working host
 *  (i.e. shadow-DOM-retargeted hit) AND the shield is in passthrough mode
 *  AND the chain has at least one page element behind the host. This is
 *  what every successful agent click looks like under the post-fix overlay
 *  CSS — flagging it as OVERLAY-INTERCEPT would be a false-positive log
 *  warn on every successful click. The retargeting nuance is documented
 *  in the runClickDiagnostic doc above.
 *
 *  Returns true when this exact shape holds; callers should treat the
 *  click as having landed on a real page element. */
function isHostRetargetedBenign(
  top: string,
  chain: string[],
  shieldPe: string | null | undefined,
): boolean {
  const isHostTop = /^div#openbrowse-cua-working-host\b/.test(top);
  if (!isHostTop) return false;
  if (shieldPe !== "none") return false;
  // chain[0] is the host itself (the same string as `top`); chain[1+] are
  // what's BEHIND the host. If any of those is not an OpenBrowse overlay,
  // the page element absorbed the click as designed.
  return chain
    .slice(1)
    .some((el) => !looksLikeOpenBrowseOverlay(el));
}

/**
 * Run the diagnostic. `source` identifies which click path is calling us
 * (e.g. "cua/click", "tool/clickByRef") so the log line is self-describing.
 *
 * Returns the raw diagnostic response so callers can react (e.g. abort the
 * dispatch, retry the passthrough toggle). Returns `null` on dispatch
 * failure. Never throws.
 */
export async function runClickDiagnostic(
  driver: BrowserDriver,
  tabId: TabId,
  source: string,
  x: number,
  y: number,
): Promise<ClickDiagnosticResponse | null> {
  let diag: ClickDiagnosticResponse | undefined;
  try {
    diag = await driver.sendToContentScript<ClickDiagnosticResponse>(tabId, {
      type: "CHAT_CUA_DIAG_HIT_TEST",
      x,
      y,
    });
  } catch (err) {
    console.warn(
      `[click-diag] ${source}@(${x},${y}) tab=${String(tabId)} diagnostic dispatch failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!diag?.ok) {
    console.warn(
      `[click-diag] ${source}@(${x},${y}) tab=${String(tabId)} diagnostic failed:`,
      diag?.error ?? "no response",
    );
    return diag ?? null;
  }
  const top = diag.top ?? "";
  const chain = diag.chain ?? [];
  // Search overlay's backdrop is `.sb-backdrop` with pe:auto and ALWAYS
  // intercepts. Treat it as an unconditional block — even if the click
  // appears to land on a real page element, the backdrop is between the
  // click point and the page element and will eat input events. This
  // takes priority over the benign-retarget check below.
  const searchOverlayBlocking = diag.searchOverlayMounted === true;
  // Classify the hit. The retargeted-host signal is REAL only when an
  // OpenBrowse overlay is on top AND it isn't the benign shadow-DOM-
  // retargeted host shape that every successful agent click produces.
  // See `isHostRetargetedBenign` for the precise condition.
  const benign =
    !searchOverlayBlocking &&
    isHostRetargetedBenign(top, chain, diag.shieldComputedPointerEvents);
  const obIntercepted =
    !benign &&
    (looksLikeOpenBrowseOverlay(top) || searchOverlayBlocking);
  const offViewport =
    x < 0 ||
    y < 0 ||
    (diag.innerWidth != null && x > diag.innerWidth) ||
    (diag.innerHeight != null && y > diag.innerHeight);
  // Tag granularity:
  //   ok         — click landed on a page element (incl. via shadow-DOM
  //                retargeting — the common, healthy case)
  //   ok-retarget— same as ok but the diagnostic saw the retargeted host
  //                and we resolved it to benign. Useful breadcrumb when
  //                investigating "click lands on host?" — the answer is
  //                "yes, but it's our host's shadow being retargeted, not
  //                an interception". Emitted at console.debug to keep the
  //                normal-path noise low.
  //   OFF-VIEWPORT
  //   OVERLAY-INTERCEPT
  const tag = obIntercepted
    ? "OVERLAY-INTERCEPT"
    : offViewport
      ? "OFF-VIEWPORT"
      : benign
        ? "ok-retarget"
        : "ok";
  // Only the genuinely-bad shapes warrant a console.warn — we previously
  // warned on every click which trained engineers to ignore the channel.
  // `ok-retarget` goes to console.debug (hidden by default); `ok` to
  // console.debug too — the dispatch log already emits at info elsewhere.
  const log =
    tag === "OVERLAY-INTERCEPT" || tag === "OFF-VIEWPORT"
      ? console.warn
      : console.debug;
  // Inline ALL the key fields so the log is readable without expanding the
  // collapsed Object DevTools shows. We still pass the raw `diag` object as
  // a final argument so it's available for inspection if needed.
  log.call(
    console,
    `[click-diag] ${source}@(${x},${y}) tab=${String(tabId)} ${tag} ` +
      `top=${diag.top ?? "?"} ` +
      `chain=[${(diag.chain ?? []).slice(0, 4).join(" > ")}] ` +
      `shieldPE=${diag.shieldComputedPointerEvents ?? "n/a"} ` +
      `cuaActing=${diag.cuaAgentActing} ` +
      `cuaHostMounted=${diag.cuaWorkingHostMounted} ` +
      `searchOverlay=${diag.searchOverlayMounted} ` +
      `dpr=${diag.devicePixelRatio} ` +
      `vp=${diag.innerWidth}x${diag.innerHeight} ` +
      `vvScale=${diag.visualViewportScale ?? "n/a"} ` +
      `scroll=(${diag.scrollX},${diag.scrollY}) ` +
      `url=${diag.url}`,
    diag,
  );
  return diag;
}
