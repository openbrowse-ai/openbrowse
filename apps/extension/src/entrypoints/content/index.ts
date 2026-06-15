const OVERLAY_HOST_ID = "openbrowse-overlay-host";
const TOAST_HOST_ID = "openbrowse-toast-host";
const AGENT_TOAST_HOST_ID = "openbrowse-agent-toast-host";
const RIPPLE_HOST_ID = "openbrowse-cua-ripple-host";
const CUA_WORKING_HOST_ID = "openbrowse-cua-working-host";

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let activeUndoHandler: (() => void) | null = null;
let undoKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function getOrCreateToastHost() {
  let host = document.getElementById(TOAST_HOST_ID);
  if (host) return host.shadowRoot!;
  host = document.createElement("div");
  host.id = TOAST_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .sb-toast-container {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .sb-toast {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      color: #fafafa;
      background: #18181b;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1);
      animation: sb-toast-in 0.2s ease-out;
      transition: opacity 0.15s ease-out, transform 0.15s ease-out;
    }
    @media (prefers-color-scheme: light) {
      .sb-toast {
        color: #18181b;
        background: #fff;
        border: 1px solid #e4e4e7;
        box-shadow: 0 4px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
      }
      .sb-toast-undo { background: #18181b !important; color: #fafafa !important; }
      .sb-toast-undo:hover { opacity: 0.9 !important; }
      .sb-toast-kbd { background: rgba(255,255,255,0.15) !important; color: rgba(255,255,255,0.7) !important; }
    }
    .sb-toast.sb-toast-out {
      opacity: 0;
      transform: translateY(8px);
    }
    .sb-toast-undo {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #fafafa;
      color: #18181b;
      border: none;
      padding: 0 8px;
      height: 24px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      line-height: 1;
      flex-shrink: 0;
      transition: opacity 0.2s;
    }
    .sb-toast-undo:hover { opacity: 0.9; }
    .sb-toast-kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 18px;
      min-width: 18px;
      padding: 0 5px;
      border-radius: 4px;
      background: rgba(0,0,0,0.08);
      font-size: 11px;
      font-weight: 500;
      font-family: inherit;
      line-height: 1;
      color: #52525b;
      border: none;
    }
    @keyframes sb-toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  const container = document.createElement("div");
  container.className = "sb-toast-container";
  shadow.appendChild(style);
  shadow.appendChild(container);
  document.body.appendChild(host);
  return shadow;
}

function performUndo(undoData: any) {
  chrome.runtime.sendMessage({ type: "OVERLAY_UNDO", undoData }).then(() => {
    const host = document.getElementById(OVERLAY_HOST_ID);
    const iframe = host?.shadowRoot?.querySelector("iframe");
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(
        { type: "OPENBROWSE_UNDO_COMPLETE" },
        "*",
      );
    }
  });
}

function dismissToast() {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
  if (undoKeyHandler) {
    document.removeEventListener("keydown", undoKeyHandler);
    undoKeyHandler = null;
  }
  activeUndoHandler = null;
  const host = document.getElementById(TOAST_HOST_ID);
  const toast = host?.shadowRoot?.querySelector(".sb-toast");
  if (toast) {
    toast.classList.add("sb-toast-out");
    setTimeout(() => toast.remove(), 150);
  }
}

/**
 * Show a transient click ripple at viewport coordinates (CSS px). Used by the
 * Computer Use (CUA) agent so a human watching the live tab can see where the
 * agent clicked. Coordinates are viewport-relative (CDP Input.dispatchMouseEvent
 * uses viewport coords), so `position: fixed` matches without scroll offset.
 * The ripple lives in its own Shadow-DOM host with pointer-events:none and is
 * fired AFTER the agent captures its screenshot, so it never appears in the
 * image sent to the model.
 */
function getOrCreateRippleHost(): ShadowRoot {
  const existing = document.getElementById(RIPPLE_HOST_ID);
  if (existing) return existing.shadowRoot!;
  const host = document.createElement("div");
  host.id = RIPPLE_HOST_ID;
  // Host itself is inert and full-viewport; children are positioned fixed.
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  // "Dithered shockwave" click ripple — Option C from the design preview.
  // Each click spawns a 5-child burst at the click point:
  //
  //   .ob-ripple-burst (positioning anchor at the click coord)
  //     .ob-ripple-halo  (soft ambient glow, fades fast — gives the colour hit)
  //     .ob-ripple-disc  (multi-tile dither dot grid masked into a soft circle —
  //                        the "texture" layer that reads as a digital ripple)
  //     .ob-ripple-ring2 (outer dashed ring expanding slow — depth + parallax)
  //     .ob-ripple-ring1 (inner solid ring expanding fast — shockwave)
  //     .ob-ripple-spark (tiny white-cored pip at the click coord — focal punch)
  //
  // Animation timing:
  //   0ms      – spark + halo fire (immediate impact frame)
  //   0–120ms  – disc punches in from scale(0.18) → scale(0.5)  (anticipation→impact)
  //   120–750ms– disc + rings expand and fade  (dispersion)
  //   ~850ms   – host torn down (cleanup, no children left)
  //
  // Color theming uses two complementary CSS-var families set per-burst by
  // applyRippleGlow():
  //   --ob-ripple-tint                  raw hex of the active space colour
  //                                      (used by halo / rings / spark — they need
  //                                      a saturated, punchy stroke not an alpha)
  //   --ob-ripple-{strong,mid,soft,bg}  alpha-stepped variants (used by the
  //                                      dither disc's gradient layers)
  //
  // Both fall back to CUA_DEFAULT_GLOW when no space colour is cached, mirroring
  // applyCuaGlow's pattern for the working-overlay border so a click ripple
  // visually matches the active space tint.
  //
  // Reduced-motion: collapses to a 350ms cross-fade of halo + spark only;
  // no scale, no dither expansion. Matches WCAG SC 2.3.3 expectations.
  style.textContent = `
    .ob-ripple-burst {
      position: fixed;
      pointer-events: none;
    }
    .ob-ripple-halo {
      position: absolute;
      width: 140px;
      height: 140px;
      left: -70px;
      top: -70px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--ob-ripple-tint) 0%, transparent 65%);
      opacity: 0.45;
      transform: scale(0.4);
      animation: ob-ripple-halo 750ms ease-out forwards;
    }
    .ob-ripple-disc {
      position: absolute;
      width: 110px;
      height: 110px;
      left: -55px;
      top: -55px;
      border-radius: 50%;
      background-image:
        radial-gradient(circle, var(--ob-ripple-strong) 32%, transparent 34%),
        radial-gradient(circle, var(--ob-ripple-mid) 28%, transparent 36%);
      background-size: 4px 4px, 6px 6px;
      background-position: 0 0, 2px 2px;
      -webkit-mask: radial-gradient(circle, #000 22%, rgba(0,0,0,0.7) 50%, transparent 78%);
              mask: radial-gradient(circle, #000 22%, rgba(0,0,0,0.7) 50%, transparent 78%);
      transform: scale(0.18);
      opacity: 1;
      animation: ob-ripple-disc 750ms cubic-bezier(0.1, 0.85, 0.25, 1) forwards;
    }
    .ob-ripple-ring1,
    .ob-ripple-ring2 {
      position: absolute;
      border-radius: 50%;
    }
    .ob-ripple-ring1 {
      width: 50px;
      height: 50px;
      left: -25px;
      top: -25px;
      border: 1.5px solid var(--ob-ripple-tint);
      transform: scale(0.4);
      opacity: 1;
      animation: ob-ripple-ring1 750ms cubic-bezier(0.2, 0.8, 0.3, 1) forwards;
    }
    .ob-ripple-ring2 {
      width: 80px;
      height: 80px;
      left: -40px;
      top: -40px;
      border: 1.5px dashed var(--ob-ripple-tint);
      transform: scale(0.5);
      opacity: 0.7;
      animation: ob-ripple-ring2 750ms cubic-bezier(0.25, 0.7, 0.4, 1) forwards;
    }
    .ob-ripple-spark {
      position: absolute;
      width: 12px;
      height: 12px;
      left: -6px;
      top: -6px;
      border-radius: 50%;
      background: radial-gradient(circle, #fff 0%, var(--ob-ripple-tint) 60%, transparent 100%);
      transform: scale(0.5);
      opacity: 1;
      animation: ob-ripple-spark 240ms ease-out forwards;
    }
    @keyframes ob-ripple-halo {
      0%   { opacity: 0.5; transform: scale(0.4); }
      50%  { opacity: 0.3; }
      100% { opacity: 0;   transform: scale(1.5); }
    }
    @keyframes ob-ripple-disc {
      0%   { transform: scale(0.18); opacity: 1; }
      16%  { transform: scale(0.5);  opacity: 1; }
      100% { transform: scale(1.55); opacity: 0; }
    }
    @keyframes ob-ripple-ring1 {
      0%   { transform: scale(0.4); opacity: 1; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    @keyframes ob-ripple-ring2 {
      0%   { transform: scale(0.5); opacity: 0.7; }
      100% { transform: scale(1.8); opacity: 0; }
    }
    @keyframes ob-ripple-spark {
      0%   { transform: scale(0.5); opacity: 1; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      /* Cross-fade only — no scale animation. Halo + spark do all the
         signalling; the dither / rings would add motion noise without
         providing extra information for a user who's asked us to dial
         motion down. */
      .ob-ripple-halo,
      .ob-ripple-spark {
        animation: ob-ripple-fade 350ms ease-out forwards;
        transform: scale(1);
      }
      .ob-ripple-disc,
      .ob-ripple-ring1,
      .ob-ripple-ring2 { display: none; }
      @keyframes ob-ripple-fade {
        0%   { opacity: 0.7; }
        100% { opacity: 0;   }
      }
    }
  `;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);
  return shadow;
}

/** Set the ripple glow CSS variables on a host element from a hex color.
 *  Mirrors `applyCuaGlow` for the working-overlay border so a click ripple
 *  visually matches the active space tint.
 *
 *  Two complementary var families are set:
 *    - `--ob-ripple-tint`: the raw hex (no alpha). Used by halo / rings /
 *      spark — solid stroke colours that need to read clearly on any
 *      background. Wrapping in rgba() is wrong here because the existing
 *      element opacity (e.g. `.ob-ripple-halo { opacity: .45 }`) already
 *      controls the layer's alpha.
 *    - `--ob-ripple-{strong,mid,soft,bg}`: alpha-stepped rgba variants. Used
 *      by the dither disc's stacked radial-gradients where individual dot
 *      density / brightness needs separate alphas to read as halftone dither.
 */
function applyRippleGlow(host: HTMLElement, hex: string) {
  host.style.setProperty("--ob-ripple-tint", hex);
  host.style.setProperty("--ob-ripple-strong", rgba(hex, 0.95));
  host.style.setProperty("--ob-ripple-mid", rgba(hex, 0.55));
  host.style.setProperty("--ob-ripple-soft", rgba(hex, 0.25));
  host.style.setProperty("--ob-ripple-bg", rgba(hex, 0.12));
}

function showClickRipple(x: number, y: number) {
  try {
    const shadow = getOrCreateRippleHost();
    // Theme the ripple from the cached space color (set by the latest
    // CHAT_CUA_WORKING_STATE message). Falls through to CUA_DEFAULT_GLOW
    // when no space color is known — matches the working-overlay border
    // fallback so a ripple before any working state still renders cleanly.
    const tint =
      cachedSpaceColor && parseHex(cachedSpaceColor)
        ? cachedSpaceColor
        : CUA_DEFAULT_GLOW;
    const burst = document.createElement("div");
    burst.className = "ob-ripple-burst";
    burst.style.left = `${x}px`;
    burst.style.top = `${y}px`;
    // Apply per-burst so a mid-session space-color change tints the next
    // ripple without re-creating the host.
    applyRippleGlow(burst, tint);
    // Children, in z-order: halo (back), disc, outer ring, inner ring, spark (front).
    // Outer-ring-before-inner-ring on purpose — the inner solid ring should
    // read as the "leading edge" of the shockwave, drawing on top of the
    // dashed outer ring.
    burst.innerHTML = `
      <div class="ob-ripple-halo"></div>
      <div class="ob-ripple-disc"></div>
      <div class="ob-ripple-ring2"></div>
      <div class="ob-ripple-ring1"></div>
      <div class="ob-ripple-spark"></div>
    `;
    shadow.appendChild(burst);
    setTimeout(() => {
      burst.remove();
      // Tear down the host once its last burst has finished, so the inert
      // full-viewport overlay doesn't linger on the page indefinitely after
      // the agent stops clicking. A fresh burst just re-creates it.
      if (shadow.querySelectorAll(".ob-ripple-burst").length === 0) {
        document.getElementById(RIPPLE_HOST_ID)?.remove();
      }
    }, 850);
  } catch {
    // Never let a visual flourish break anything.
  }
}

function showToast(message: string, undoData?: any) {
  const shadow = getOrCreateToastHost();
  const container = shadow.querySelector(".sb-toast-container")!;

  dismissToast();

  const toast = document.createElement("div");
  toast.className = "sb-toast";

  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  if (undoData) {
    const doUndo = () => {
      performUndo(undoData);
      dismissToast();
    };
    activeUndoHandler = doUndo;

    const btn = document.createElement("button");
    btn.className = "sb-toast-undo";
    const label = document.createTextNode("Undo");
    btn.appendChild(label);
    const kbd = document.createElement("span");
    kbd.className = "sb-toast-kbd";
    kbd.textContent = "⌘Z";
    btn.appendChild(kbd);
    btn.addEventListener("click", doUndo);
    toast.appendChild(btn);

    undoKeyHandler = (e: KeyboardEvent) => {
      if (
        e.key === "z" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        doUndo();
      }
    };
    document.addEventListener("keydown", undoKeyHandler);
  }

  container.appendChild(toast);

  toastTimeout = setTimeout(() => dismissToast(), 4000);
}

function getOrCreateAgentToastHost(): ShadowRoot {
  let host = document.getElementById(AGENT_TOAST_HOST_ID);
  if (host) return host.shadowRoot!;
  host = document.createElement("div");
  host.id = AGENT_TOAST_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .ab-root {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483646;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .ab-pill {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px 8px 14px;
      border-radius: 8px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      line-height: 1.3;
      color: #18181b;
      background: #fff;
      border: 1px solid #e4e4e7;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05);
      animation: ab-in 0.18s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .ab-pill { color: #fafafa; background: #18181b; border-color: rgba(255,255,255,0.08); }
      .ab-sep { background: rgba(255,255,255,0.1) !important; }
    }
    .ab-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #f97316;
      flex-shrink: 0;
    }
    .ab-sep {
      width: 1px;
      height: 16px;
      background: rgba(0,0,0,0.08);
    }
    .ab-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 2px;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 0;
      opacity: 0.75;
      transition: opacity 0.15s;
    }
    .ab-btn:hover { opacity: 1; background: rgba(0,0,0,0.04); }
    @media (prefers-color-scheme: dark) {
      .ab-btn:hover { background: rgba(255,255,255,0.06); }
    }
    @keyframes ab-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  const container = document.createElement("div");
  container.className = "ab-root";
  shadow.appendChild(style);
  shadow.appendChild(container);
  document.body.appendChild(host);
  return shadow;
}

function removeAgentToast() {
  document.getElementById(AGENT_TOAST_HOST_ID)?.remove();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Computer Use (CUA) "working on this page" overlay.
 *
 * Shows a breathing inset glow hugging the viewport edge + a centered pill
 * ("OpenBrowse is working on this tab") and BLOCKS user input while the CUA
 * agent drives the tab.
 *
 * The blocking is subtle: the CUA agent itself clicks/types via CDP
 * `Input.dispatchMouseEvent` / `dispatchKeyEvent`, which produce TRUSTED
 * events indistinguishable from the user's — and which respect DOM
 * hit-testing, so a pointer-events shield would block the agent too. The
 * executor therefore TOGGLES passthrough (`__obAgentActing`) around each of
 * its actions (see cua-loop.ts): while the agent is acting, the shield lets
 * events through; otherwise it blocks the user. The race window is the few
 * ms of an awaited action.
 * ────────────────────────────────────────────────────────────────────────── */

let cuaAgentActing = false;
let cuaKeyBlocker: ((e: KeyboardEvent) => void) | null = null;
/** Blocks user wheel/touch scrolling while the overlay is up (the key blocker
 *  already covers scroll keys). Gated on cuaAgentActing so the agent's own
 *  actions pass through; CDP-injected scrolls bypass DOM listeners anyway. */
let cuaScrollBlocker: ((e: Event) => void) | null = null;

/** Live color-scheme watcher for the working pill's logo. CSS @media can theme
 *  the pill's colors, but not swap an <img src>, so we flip the logo variant in
 *  JS whenever the OS/browser theme changes while the overlay is mounted. */
let cuaThemeMql: MediaQueryList | null = null;
let cuaThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

/** Most-recent space color forwarded by `notifyAgentStatus(true, color)` via
 *  `CHAT_CUA_WORKING_STATE`. Cached here so click ripples (which fire many
 *  times per agent run, often outside the working-state lifecycle of any
 *  individual message) can tint themselves to match the active space without
 *  every ripple-sender re-piping the color. Falls back to CUA_DEFAULT_GLOW
 *  in showClickRipple when no working state has set it yet. */
let cachedSpaceColor: string | null = null;

/** URL of the OpenBrowse logo that contrasts with the current theme's pill:
 *  white logo on the dark-mode pill, black logo on the light-mode pill. */
function cuaLogoUrl(dark: boolean): string {
  return chrome.runtime.getURL(dark ? "icon/logo-dark.svg" : "icon/logo.svg");
}

/** Fallback glow color (OpenBrowse logo blue). Used when no space color is set. */
const CUA_DEFAULT_GLOW = "#056BB3";

/** Parse a #rgb / #rrggbb hex string into [r,g,b]. Returns null if unparseable. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Build an rgba() string from a hex color + alpha (0..1). */
function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? parseHex(CUA_DEFAULT_GLOW)!;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function getOrCreateCuaWorkingHost(color?: string | null): ShadowRoot {
  const glow = color && parseHex(color) ? color.trim() : CUA_DEFAULT_GLOW;
  const existing = document.getElementById(CUA_WORKING_HOST_ID);
  if (existing) {
    // Re-tint an already-mounted overlay (agent moved spaces mid-run).
    applyCuaGlow(existing.shadowRoot!, glow);
    return existing.shadowRoot!;
  }
  const host = document.createElement("div");
  host.id = CUA_WORKING_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .ob-cua-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      /* CRITICAL: pointer-events:none on the root so trusted CDP mouse
         events the agent dispatches can pass through to the page when
         the shield is also pe:none. Without this, hit-testing climbs from
         a pe:none shield to its parent (the root, default pe:auto) and
         the click is silently eaten by the root — even though every
         visible child (.ob-cua-shield with .ob-passthrough, .ob-cua-border,
         .ob-cua-pill) is itself pe:none. Per the CSS pointer-events spec,
         pe:none on a parent does NOT disable descendants with explicit
         pe:auto, so .ob-cua-shield (default pe:auto) still catches user
         clicks (idle state, blocking user input), and the .ob-cua-stop
         button (explicit pe:auto) still works inside the pill. */
      pointer-events: none;
    }
    /* Full-viewport input blocker. pointer-events toggled by the executor. */
    .ob-cua-shield {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.02);
      cursor: progress;
      overscroll-behavior: none;
    }
    .ob-cua-shield.ob-passthrough {
      pointer-events: none;
    }
    /* Comet-style ambient inset glow hugging the viewport edge. The glow
       color is driven by the active space color via --ob-glow-* CSS vars
       (set by applyCuaGlow). A gentle "breathing" pulse signals activity. */
    .ob-cua-border {
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: 0;
      box-shadow:
        inset 0 9px 6px -1px var(--ob-glow-soft),
        inset 0 -12px 10px -3px rgba(251, 250, 244, 0.40),
        inset 0 -15px 15px 4px var(--ob-glow-mid),
        inset 0 -21px 48px var(--ob-glow-strong);
      animation: ob-cua-breathe 2.4s ease-in-out infinite;
    }
    .ob-cua-pill {
      position: absolute;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      color: #18181b;
      background: #fff;
      border: 1px solid #e4e4e7;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05);
      animation: ob-cua-in 0.2s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .ob-cua-pill {
        color: #fafafa;
        background: #18181b;
        border-color: rgba(255,255,255,0.08);
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
    }
    .ob-cua-spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid rgba(0,0,0,0.2);
      border-top-color: #18181b;
      animation: ob-cua-spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @media (prefers-color-scheme: dark) {
      .ob-cua-spinner {
        border-color: rgba(255,255,255,0.35);
        border-top-color: #fff;
      }
    }
    .ob-cua-stop {
      background: #18181b;
      color: #fafafa;
      border: none;
      padding: 4px 10px;
      border-radius: 2px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      pointer-events: auto;
    }
    @media (prefers-color-scheme: dark) {
      .ob-cua-stop {
        background: #fafafa;
        color: #18181b;
      }
    }
    @keyframes ob-cua-breathe {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 1; }
    }
    @keyframes ob-cua-spin { to { transform: rotate(360deg); } }
    @keyframes ob-cua-in {
      from { opacity: 0; transform: translate(-50%, 8px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ob-cua-border { animation: none; opacity: 0.92; }
      .ob-cua-spinner { animation: none; }
    }
  `;
  const root = document.createElement("div");
  root.className = "ob-cua-root";

  const prefersDark = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches;
  const logoUrl = cuaLogoUrl(prefersDark);

  root.innerHTML = `
    <div class="ob-cua-border"></div>
    <div class="ob-cua-shield"></div>
    <div class="ob-cua-pill">
      <img class="ob-cua-logo" src="${logoUrl}" style="width:18px;height:18px;border-radius:4px;">
      <span>OpenBrowse is working on this tab</span>
      <button class="ob-cua-stop">Stop</button>
    </div>
  `;
  root.querySelector(".ob-cua-stop")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "AGENT_STOP" });
    removeCuaWorking();
  });
  shadow.appendChild(style);
  shadow.appendChild(root);
  applyCuaGlow(shadow, glow);
  document.documentElement.appendChild(host);

  // Live-swap the logo variant if the theme changes while the overlay is up.
  // Assign the MediaQueryList and listener together (commit both refs only
  // after addEventListener succeeds) so the pair is never left asymmetric —
  // removeCuaWorking relies on `cuaThemeMql && cuaThemeListener` to tear it
  // down.
  if (!cuaThemeMql) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => {
      const img = document
        .getElementById(CUA_WORKING_HOST_ID)
        ?.shadowRoot?.querySelector<HTMLImageElement>(".ob-cua-logo");
      if (img) img.src = cuaLogoUrl(e.matches);
    };
    mql.addEventListener("change", listener);
    cuaThemeMql = mql;
    cuaThemeListener = listener;
  }

  return shadow;
}

/** Set the glow CSS variables (layered inset-shadow alphas) on the overlay
 *  root from a hex color. */
function applyCuaGlow(shadow: ShadowRoot, hex: string) {
  const root = shadow.querySelector<HTMLElement>(".ob-cua-root");
  if (!root) return;
  root.style.setProperty("--ob-glow-soft", rgba(hex, 0.16));
  root.style.setProperty("--ob-glow-mid", rgba(hex, 0.5));
  root.style.setProperty("--ob-glow-strong", rgba(hex, 1));
}

function showCuaWorking(color?: string | null) {
  getOrCreateCuaWorkingHost(color);
  // Block user keyboard input while the overlay is up, except while the agent
  // is acting (its CDP key events would otherwise be swallowed too).
  if (!cuaKeyBlocker) {
    cuaKeyBlocker = (e: KeyboardEvent) => {
      if (cuaAgentActing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener("keydown", cuaKeyBlocker, true);
    document.addEventListener("keyup", cuaKeyBlocker, true);
    document.addEventListener("keypress", cuaKeyBlocker, true);
  }
  // Block wheel + touch scrolling. Must be non-passive so preventDefault()
  // actually cancels the scroll (browsers default these to passive on
  // document). Capture phase so we beat page-level handlers.
  if (!cuaScrollBlocker) {
    cuaScrollBlocker = (e: Event) => {
      if (cuaAgentActing) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("wheel", cuaScrollBlocker, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchmove", cuaScrollBlocker, {
      capture: true,
      passive: false,
    });
  }
}

function removeCuaWorking() {
  document.getElementById(CUA_WORKING_HOST_ID)?.remove();
  if (cuaKeyBlocker) {
    document.removeEventListener("keydown", cuaKeyBlocker, true);
    document.removeEventListener("keyup", cuaKeyBlocker, true);
    document.removeEventListener("keypress", cuaKeyBlocker, true);
    cuaKeyBlocker = null;
  }
  if (cuaScrollBlocker) {
    document.removeEventListener("wheel", cuaScrollBlocker, true);
    document.removeEventListener("touchmove", cuaScrollBlocker, true);
    cuaScrollBlocker = null;
  }
  // Always tear down the theme listener. Remove it whenever both the
  // MediaQueryList and the listener fn exist (the only state in which one was
  // registered), then unconditionally null BOTH refs so a partial-init state
  // can never leave a stale MediaQueryList that blocks re-registration on the
  // next show.
  if (cuaThemeMql && cuaThemeListener) {
    cuaThemeMql.removeEventListener("change", cuaThemeListener);
  }
  cuaThemeMql = null;
  cuaThemeListener = null;
  cuaAgentActing = false;
}

/** Toggle whether the agent is mid-action (lets its CDP input through the
 *  shield + key blocker). Logs the effective shield state to the page
 *  console so we can correlate page-side behavior with service-worker-side
 *  diagnostics when investigating "agent click did nothing". */
function setCuaPassthrough(on: boolean) {
  cuaAgentActing = on;
  const host = document.getElementById(CUA_WORKING_HOST_ID);
  const shield = host?.shadowRoot?.querySelector(
    ".ob-cua-shield",
  ) as HTMLElement | null;
  if (shield) shield.classList.toggle("ob-passthrough", on);
  // Read the COMPUTED pointer-events synchronously — this is what hit-testing
  // will actually see. If shield exists but pe != "none" after on=true, the
  // CSS class isn't applying (specificity, shadow CSS not parsed, etc.).
  // Logged at console.debug — fires twice per CDP action so console.info
  // would drown the page console; surfaces only when DevTools Verbose is on.
  const pe = shield ? getComputedStyle(shield).pointerEvents : "no-shield";
  console.debug(
    `[ob-passthrough] on=${on} hostMounted=${!!host} shieldFound=${!!shield} computedPE=${pe}`,
  );
}

function showAgentActiveToast() {
  const shadow = getOrCreateAgentToastHost();
  const container = shadow.querySelector(".ab-root")!;
  if (container.querySelector(".ab-pill")) return;

  const pill = document.createElement("div");
  pill.className = "ab-pill";

  const dot = document.createElement("span");
  dot.className = "ab-dot";
  pill.appendChild(dot);

  const label = document.createElement("span");
  label.textContent = "Agent is active in this tab";
  pill.appendChild(label);

  const sep = document.createElement("span");
  sep.className = "ab-sep";
  pill.appendChild(sep);

  const openBtn = document.createElement("button");
  openBtn.className = "ab-btn";
  openBtn.title = "Open chat";
  openBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  openBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL_FROM_OVERLAY" });
  });
  pill.appendChild(openBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "ab-btn";
  dismissBtn.title = "Dismiss";
  dismissBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  dismissBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "DISMISS_TOAST" });
    removeAgentToast();
  });
  pill.appendChild(dismissBtn);

  container.appendChild(pill);
}

function removeOverlay() {
  document.getElementById(OVERLAY_HOST_ID)?.remove();
  document.body.style.overflow = "";
}

function createOverlay(action?: string) {
  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .sb-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 20vh;
    }
    .sb-frame {
      width: 580px;
      max-width: 90vw;
      max-height: 70vh;
      border: none;
      border-radius: 8px;
      background: transparent;
      color-scheme: light dark;
    }
  `;

  const backdrop = document.createElement("div");
  backdrop.className = "sb-backdrop";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) removeOverlay();
  });

  const iframe = document.createElement("iframe");
  iframe.className = "sb-frame";
  const overlayUrl = action
    ? chrome.runtime.getURL(`/overlay.html?action=${action}`)
    : chrome.runtime.getURL("/overlay.html");
  iframe.src = overlayUrl;

  backdrop.appendChild(iframe);
  shadow.appendChild(style);
  shadow.appendChild(backdrop);
  document.body.appendChild(host);
  document.body.style.overflow = "hidden";

  iframe.addEventListener("load", () => iframe.focus());

  // Re-append toast host so it renders above the overlay
  const toastHost = document.getElementById(TOAST_HOST_ID);
  if (toastHost) document.body.appendChild(toastHost);
}

function toggleOverlay(action?: string) {
  const existing = document.getElementById(OVERLAY_HOST_ID);
  if (existing) {
    existing.remove();
  } else {
    createOverlay(action);
  }
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "GET_PAGE_CONTEXT") {
        sendResponse(extractPageContext());
      }
      if (message.type === "TOGGLE_OVERLAY") {
        toggleOverlay(message.action);
        sendResponse({ ok: true });
      }
      if (message.type === "CHAT_EXTRACT_CONTENT") {
        sendResponse(extractDetailedContent());
      }
      if (message.type === "CHAT_CLICK_ELEMENT") {
        try {
          const el = document.querySelector(
            message.selector,
          ) as HTMLElement | null;
          if (!el) {
            sendResponse({
              success: false,
              error: `Element not found: ${message.selector}`,
            });
          } else {
            el.click();
            // Visual feedback parity with the @ref / CUA click paths: ripple
            // at the element's viewport-center so a human watching the live
            // tab sees the same animation regardless of which click path
            // resolved the target. Computed AFTER el.click() so we don't
            // delay the synthetic dispatch; best-effort (rect read can fail
            // for detached or zero-box elements — never let it break the
            // click).
            try {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                showClickRipple(r.left + r.width / 2, r.top + r.height / 2);
              }
            } catch {
              // never let a visual flourish break a successful click
            }
            sendResponse({ success: true });
          }
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      }
      if (message.type === "CHAT_TYPE_IN_ELEMENT") {
        try {
          const el = document.querySelector(message.selector) as
            | HTMLInputElement
            | HTMLTextAreaElement
            | null;
          if (!el) {
            sendResponse({
              success: false,
              error: `Element not found: ${message.selector}`,
            });
          } else {
            el.focus();
            if (message.clearFirst) {
              el.value = "";
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
            el.value = message.text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            sendResponse({ success: true });
          }
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      }
      if (message.type === "OVERLAY_TOAST_STATE") {
        if (message.show) {
          showAgentActiveToast();
        } else {
          removeAgentToast();
        }
        sendResponse({ ok: true });
      }
      if (message.type === "CHAT_SCROLL_PAGE") {
        try {
          const pixels = message.amount ?? 600;
          window.scrollBy(0, message.direction === "up" ? -pixels : pixels);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      }
      if (message.type === "CHAT_CUA_CLICK_RIPPLE") {
        if (typeof message.x === "number" && typeof message.y === "number") {
          showClickRipple(message.x, message.y);
        }
        sendResponse({ ok: true });
      }
      if (message.type === "CHAT_CUA_WORKING_STATE") {
        if (message.active) {
          // Cache the space color so click ripples (which can fire after the
          // working-state message has resolved) inherit the same tint as the
          // border glow. Only update when a non-empty color was provided —
          // some callers send `active: true` with no color and we'd rather
          // keep the previously-known tint than blank it back to default.
          if (typeof message.color === "string" && message.color.trim()) {
            cachedSpaceColor = message.color.trim();
          }
          showCuaWorking(message.color);
        } else {
          removeCuaWorking();
          // Clear the cache on idle so a NEW agent run that doesn't re-send a
          // color (rare, but possible) starts from the default fallback
          // rather than a stale prior-space tint.
          cachedSpaceColor = null;
        }
        sendResponse({ ok: true });
      }
      if (message.type === "CHAT_CUA_INPUT_PASSTHROUGH") {
        setCuaPassthrough(!!message.on);
        sendResponse({ ok: true });
      }
      // Diagnostic-only: at a given (x, y), report what the page would actually
      // hit, the state of OpenBrowse's overlays, and viewport metrics. Used by
      // the CUA loop to forensically log click failures (overlay interception,
      // DPR/zoom mismatch, debugger detach, race window). Read-only — never
      // mutates page state. See cua-loop.ts.
      if (message.type === "CHAT_CUA_DIAG_HIT_TEST") {
        try {
          const x = Number(message.x);
          const y = Number(message.y);
          const describe = (el: Element | null): string => {
            if (!el) return "null";
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : "";
            const cls = el.classList.length
              ? `.${[...el.classList].slice(0, 2).join(".")}`
              : "";
            return `${tag}${id}${cls}`;
          };
          const top = document.elementFromPoint(x, y);
          // `elementsFromPoint` returns the full hit-test stack (topmost first).
          // This pierces past any overlay so the diagnostic shows what would
          // have been clicked if the overlay weren't there. Cap at 6 entries
          // to keep the log line readable.
          const stack = (document.elementsFromPoint(x, y) ?? []).slice(0, 6);
          const chain = stack.map(describe);
          const cuaHost = document.getElementById(CUA_WORKING_HOST_ID);
          const shield = cuaHost?.shadowRoot?.querySelector(
            ".ob-cua-shield",
          ) as HTMLElement | null;
          const shieldPe = shield
            ? getComputedStyle(shield).pointerEvents
            : null;
          const overlayHost = document.getElementById(OVERLAY_HOST_ID);
          sendResponse({
            ok: true,
            x,
            y,
            top: describe(top),
            chain,
            cuaWorkingHostMounted: !!cuaHost,
            shieldComputedPointerEvents: shieldPe,
            cuaAgentActing,
            searchOverlayMounted: !!overlayHost,
            devicePixelRatio: window.devicePixelRatio,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            visualViewportScale: window.visualViewport?.scale ?? null,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            url: location.href,
          });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    // These messages are posted by OpenBrowse's own overlay iframe
    // (`window.parent.postMessage(..., "*")` in OverlayApp/LogoMenu), which
    // runs at the extension origin. A malicious page sharing this window
    // could otherwise spoof OPENBROWSE_TRIGGER_UNDO / OVERLAY_CLOSE etc., so
    // only process messages that originate from the extension itself.
    const extensionOrigin = new URL(chrome.runtime.getURL("")).origin;
    window.addEventListener("message", (e) => {
      if (e.origin !== extensionOrigin) return;
      if (e.data?.type === "OPENBROWSE_OVERLAY_CLOSE") {
        removeOverlay();
      }
      if (
        e.data?.type === "OPENBROWSE_OVERLAY_RESIZE" &&
        typeof e.data.height === "number"
      ) {
        const host = document.getElementById(OVERLAY_HOST_ID);
        const iframe = host?.shadowRoot?.querySelector("iframe");
        if (iframe) iframe.style.height = `${e.data.height}px`;
      }
      if (e.data?.type === "OPENBROWSE_TOAST") {
        showToast(e.data.message, e.data.undoData);
      }
      if (e.data?.type === "OPENBROWSE_TRIGGER_UNDO") {
        if (activeUndoHandler) activeUndoHandler();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const match = e.code.match(/^Digit([1-9])$/);
      if (match) {
        e.preventDefault();
        chrome.runtime.sendMessage({
          type: "SWITCH_SPACE_BY_POSITION",
          position: parseInt(match[1], 10),
        });
      }
    });
  },
});

function extractPageContext() {
  const meta = (name: string) =>
    document
      .querySelector<HTMLMetaElement>(
        `meta[name="${name}"], meta[property="${name}"]`,
      )
      ?.content?.trim() || "";

  const h1 =
    document.querySelector("h1")?.textContent?.trim().slice(0, 200) || "";

  const description =
    meta("description") ||
    meta("og:description") ||
    meta("twitter:description");

  const bodyText =
    document.body?.innerText?.replace(/\s+/g, " ")?.trim().slice(0, 300) || "";

  return {
    h1,
    description: description.slice(0, 300),
    snippet: bodyText,
    type: meta("og:type"),
    siteName: meta("og:site_name"),
  };
}

function extractDetailedContent() {
  const readability = document.cloneNode(true) as Document;
  const scripts = readability.querySelectorAll(
    "script, style, noscript, svg, iframe",
  );
  scripts.forEach((el) => el.remove());

  const body = readability.body?.innerText?.replace(/\s+/g, " ")?.trim() || "";

  const meta = (name: string) =>
    document
      .querySelector<HTMLMetaElement>(
        `meta[name="${name}"], meta[property="${name}"]`,
      )
      ?.content?.trim() || "";

  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 50)
    .map((a) => ({
      text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 100) || "",
      href: (a as HTMLAnchorElement).href,
    }))
    .filter((l) => l.text && l.href.startsWith("http"));

  return {
    url: location.href,
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.trim().slice(0, 200) || "",
    description: meta("description").slice(0, 500),
    bodyText: body.slice(0, 10000),
    links,
  };
}
