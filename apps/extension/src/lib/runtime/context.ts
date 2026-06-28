/**
 * Runtime-context guards.
 *
 * Identifies which Chrome extension JS realm the current module is executing
 * in. Used to dispatch DOM-bound work (executeCode sandbox, local-model
 * inference) to the offscreen document when the agent loop is hosted in the
 * service worker, and to keep renderer/offscreen-aware modules importable
 * from all three realms without crashing at module-construction time.
 *
 * The three realms:
 *  - **Service worker** (MV3 background): has full `chrome.*` surface
 *    including `chrome.debugger`, `chrome.tabs`, `chrome.scripting`, but NO
 *    `window`/`document`. `self` is a `ServiceWorkerGlobalScope`.
 *  - **Offscreen document**: has DOM (`window`/`document`), can host hidden
 *    iframes + Web Workers, can issue `fetch` for cloud inference, but
 *    cannot use `chrome.debugger`/`tabs`/`scripting`. Identified by its
 *    document URL ending in `/offscreen.html`.
 *  - **Renderer extension page** (sidepanel, home, newtab, popup): has DOM
 *    and a permissive subset of `chrome.*`. Any extension page that is NOT
 *    the offscreen document.
 *
 * Detection avoids feature-sniffing `chrome.debugger` etc. because the
 * permission grants the same symbols across all realms — calling them is
 * what differs by realm. Instead we key on the structural realm shape.
 */

/**
 * True iff this module is executing inside the MV3 service worker.
 *
 * Implemented by checking that `self` is an instance of
 * `ServiceWorkerGlobalScope`. The global itself exists in modern Chromium
 * renderers as a constructor (for Worker contexts), so we check the
 * `instanceof` relationship against `self`, not just the existence of the
 * global.
 */
export function isServiceWorkerContext(): boolean {
  const swgs = (globalThis as { ServiceWorkerGlobalScope?: unknown })
    .ServiceWorkerGlobalScope;
  if (typeof swgs !== "function") return false;
  const selfRef = (globalThis as { self?: unknown }).self;
  if (selfRef == null) return false;
  try {
    return selfRef instanceof (swgs as new () => object);
  } catch {
    return false;
  }
}

/**
 * True iff this module is executing inside the extension's offscreen
 * document. Distinguished from a renderer page by the document URL
 * (`chrome-extension://<id>/offscreen.html`). The offscreen entrypoint is
 * always served from this exact path by WXT.
 *
 * Compares against the parsed URL's pathname rather than running a
 * substring check against `document.URL` — a query string or fragment
 * like `?ref=/offscreen.html` would otherwise misclassify a normal
 * renderer page as offscreen.
 */
export function isOffscreenContext(): boolean {
  const doc = (globalThis as { document?: { URL?: string } }).document;
  const url = doc?.URL;
  if (typeof url !== "string") return false;
  try {
    return new URL(url).pathname.endsWith("/offscreen.html");
  } catch {
    // Malformed URL — fall through to substring check on pathname-ish
    // suffix; safer than throwing.
    return url.endsWith("/offscreen.html");
  }
}

/**
 * True iff this module is executing inside a renderer extension page
 * (sidepanel, home, newtab, popup, options). Defined negatively: a
 * realm that has a `document` but is NOT the offscreen document, and
 * is NOT the service worker.
 */
export function isRendererContext(): boolean {
  if (isServiceWorkerContext()) return false;
  const doc = (globalThis as { document?: unknown }).document;
  if (doc == null) return false;
  return !isOffscreenContext();
}
