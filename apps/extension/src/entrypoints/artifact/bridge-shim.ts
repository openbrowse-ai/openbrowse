// apps/extension/src/entrypoints/artifact/bridge-shim.ts
//
// Injected as a <script> into every artifact iframe. Defines
// window.openbrowse.* and forwards calls to the parent (host) frame
// via postMessage. The host validates the manifest allowlist and
// forwards approved calls to the background worker.
//
// This file MUST stay self-contained (no imports). It is exported as
// a string; the host (Host.tsx in Task 8) concatenates it into the
// iframe HTML inside a <script> tag.
//
// IMPORTANT: the string body must be valid plain JavaScript. Do NOT
// use TypeScript syntax (no `as`, no type annotations, no generics)
// inside the template — the browser parses it directly.

export const BRIDGE_SHIM_SOURCE = `
(() => {
  if (window.openbrowse) return;

  const pending = new Map();
  let nextId = 1;

  // Ring buffer of recent console.error entries, attached to error reports so
  // the agent (via "Fix with OpenBrowse") has extra diagnostic context.
  const CONSOLE_BUFFER_MAX = 5;
  const consoleBuffer = [];

  function fmtConsoleArgs(args) {
    return args
      .map((a) => {
        if (a instanceof Error) return (a.stack || a.message);
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      })
      .join(" ");
  }

  // Wrap console methods so artifact logs are (a) forwarded to the host's
  // console — the iframe is sandboxed/opaque so its console doesn't surface to
  // the developer otherwise — and (b) errors are buffered for "Fix with
  // OpenBrowse". Forwarding is fire-and-forget (no RPC reply).
  function wrapConsole(level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      var text;
      try { text = fmtConsoleArgs(args); } catch (_) { text = ""; }
      if (level === "error") {
        consoleBuffer.push(text);
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
      }
      try {
        window.parent.postMessage({ type: "ART_CONSOLE", level: level, text: text }, "*");
      } catch (_) { /* never let logging break */ }
      orig.apply(null, args);
    };
  }
  wrapConsole("log");
  wrapConsole("info");
  wrapConsole("warn");
  wrapConsole("error");

  function recentConsole() {
    return consoleBuffer.slice();
  }

  function rpc(method, payload) {
    return new Promise((resolve, reject) => {
      const reqId = nextId++;
      pending.set(reqId, { resolve, reject });
      window.parent.postMessage({ type: "ART_RPC", reqId, method, ...payload }, "*");
    });
  }

  // Forward uncaught errors and unhandled rejections to the host so it can
  // surface the "Fix with OpenBrowse" banner.
  function reportRuntimeError(message, stack, sourceFile) {
    try {
      window.parent.postMessage({
        type: "ART_RUNTIME_ERROR",
        message: String(message || "Unknown error"),
        stack: stack ? String(stack) : undefined,
        sourceFile: sourceFile || undefined,
        recentConsole: recentConsole(),
      }, "*");
    } catch (_) { /* ignore */ }
  }
  window.addEventListener("error", (e) => {
    const where = e.filename ? (e.filename + ":" + e.lineno + ":" + e.colno) : undefined;
    reportRuntimeError(e.message, e.error && e.error.stack, where);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg = reason && reason.message ? reason.message : String(reason);
    reportRuntimeError(msg, reason && reason.stack, undefined);
  });

  // Tell the host the artifact finished its initial render. Fired once, after
  // the document has parsed (DOMContentLoaded) — so it means "the synchronous
  // render completed without throwing". It does NOT wait for async work (data
  // fetches, chart draws); for those the artifact must log/console.error so the
  // failure shows up separately. Lets the host/agent distinguish a blank,
  // never-ran artifact from one that painted.
  var renderedSent = false;
  function reportRendered() {
    if (renderedSent) return;
    renderedSent = true;
    try {
      var body = document.body;
      var sample = "";
      try { sample = (body && body.innerText ? body.innerText : "").trim().slice(0, 200); } catch (_) {}
      window.parent.postMessage({
        type: "ART_RENDERED",
        childCount: body ? body.children.length : 0,
        bodyTextSample: sample,
      }, "*");
    } catch (_) { /* ignore */ }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportRendered);
  } else {
    // Document already parsed by the time the shim ran — defer one task so any
    // synchronous body content from the same parse is in place.
    setTimeout(reportRendered, 0);
  }

  const themeListeners = new Set();

  function applyThemeVars(theme) {
    const root = document.documentElement;
    const vars = (theme && theme.vars) || {};
    for (const k of Object.keys(vars)) {
      root.style.setProperty(k, vars[k]);
    }
    var dark = theme && theme.mode === "dark";
    root.style.colorScheme = dark ? "dark" : "light";
    // Reflect the mode as a class so artifacts can style with .dark /
    // html.dark selectors (and CSS that keys off it) without subscribing.
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "ART_RPC_OK") {
      const p = pending.get(m.reqId);
      if (!p) return;
      pending.delete(m.reqId);
      p.resolve(m.result);
    } else if (m.type === "ART_RPC_ERR") {
      const p = pending.get(m.reqId);
      if (!p) return;
      pending.delete(m.reqId);
      p.reject(new Error(m.error));
    } else if (m.type === "ART_INIT") {
      window.openbrowse.theme = m.theme;
      window.openbrowse.artifact = m.identity;
      applyThemeVars(m.theme);
      window.dispatchEvent(new Event("openbrowse:ready"));
    } else if (m.type === "ART_THEME") {
      window.openbrowse.theme = m.theme;
      applyThemeVars(m.theme);
      themeListeners.forEach((cb) => { try { cb(m.theme); } catch (_) {} });
    }
  });

  // Normalize a HeadersInit (Headers | object | array of pairs) to a plain
  // object so it survives structured-clone over postMessage.
  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof Headers !== "undefined" && h instanceof Headers) {
      h.forEach((v, k) => { out[k] = v; });
    } else if (Array.isArray(h)) {
      for (const pair of h) { if (pair && pair.length === 2) out[pair[0]] = pair[1]; }
    } else if (typeof h === "object") {
      for (const k of Object.keys(h)) out[k] = h[k];
    }
    return out;
  }

  // Base64 <-> ArrayBuffer. Bodies cross chrome.runtime.sendMessage, which
  // serializes as JSON — a raw ArrayBuffer would arrive as {}. Mirror of
  // lib/artifacts/base64.ts (the shim can't import). Kept in lock-step by
  // base64-roundtrip.test.ts.
  function b64FromBuf(buf) {
    var bytes = new Uint8Array(buf);
    var binary = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  function bufFromB64(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // Brokered fetch: the artifact runs in a sandboxed (opaque-origin) iframe, so
  // most cross-origin fetches are CORS-blocked. The host/background performs the
  // request on the artifact's behalf, restricted to manifest.network[]. Returns
  // a real Response so callers use it like window.fetch.
  async function networkFetch(input, init) {
    const url = typeof input === "string" ? input : (input && input.href) || String(input);
    init = init || {};
    var rawBody = init.body;
    // Normalize the request body: text -> { body }, binary -> { bodyB64 }.
    var bodyStr;
    var bodyB64;
    if (rawBody == null) {
      // no body
    } else if (typeof rawBody === "string") {
      bodyStr = rawBody;
    } else if (rawBody instanceof Blob) {
      bodyB64 = b64FromBuf(await rawBody.arrayBuffer());
    } else if (rawBody instanceof ArrayBuffer) {
      bodyB64 = b64FromBuf(rawBody);
    } else if (rawBody instanceof Uint8Array) {
      bodyB64 = b64FromBuf(rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength));
    } else if (ArrayBuffer.isView(rawBody)) {
      bodyB64 = b64FromBuf(rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength));
    } else {
      // URLSearchParams, FormData, etc. — coerce to string best-effort.
      bodyStr = String(rawBody);
    }
    const result = await rpc("network.fetch", {
      url,
      init: {
        method: init.method || "GET",
        headers: normalizeHeaders(init.headers),
        body: bodyStr,
        bodyB64: bodyB64,
        credentials: init.credentials || "omit",
      },
    });
    // The Response constructor forbids a body for "null body status" codes
    // (101/204/205/304) and rejects any status outside 200-599. The broker
    // never returns status 0, but guard the body case so these statuses
    // reconstruct instead of throwing.
    var nullBodyStatus =
      result.status === 101 || result.status === 204 ||
      result.status === 205 || result.status === 304;
    var bodyBuf = nullBodyStatus ? null : bufFromB64(result.bodyB64 || "");
    return new Response(bodyBuf, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  window.openbrowse = {
    callMcpTool: (name, args) => rpc("callMcpTool", { name, args: args || {} }),
    runTool:     (name, args) => rpc("runTool",     { name, args: args || {} }),
    kv: {
      get:    (key) => rpc("kv.get",    { key }),
      set:    (key, value) => rpc("kv.set", { key, value }),
      delete: (key) => rpc("kv.delete", { key }),
      keys:   () => rpc("kv.keys",   {}),
    },
    network: { fetch: networkFetch },
    theme: { mode: "light", vars: {} },
    onThemeChange(cb) { themeListeners.add(cb); return () => themeListeners.delete(cb); },
    artifact: { id: "", title: "", mode: "tab" },
    setCardHeight: (px) => rpc("setCardHeight", { px }),
    // Explicit forwarder to the host console, with a level. Equivalent to
    // console[level](...) (which is also forwarded), but discoverable on the
    // openbrowse surface for artifacts that want to log intentionally.
    log: function (level) {
      var args = Array.prototype.slice.call(arguments, 1);
      var lvl = (level === "info" || level === "warn" || level === "error") ? level : "log";
      if (console[lvl]) console[lvl].apply(console, args);
      else console.log.apply(console, args);
    },
    toast: (message, opts) => {
      const level = opts && opts.type;
      return rpc("toast", {
        message,
        level,
        recentConsole: level === "error" ? recentConsole() : undefined,
      });
    },
  };

  // Tell the host the bridge is installed so it can deliver ART_INIT
  // (theme + identity) once window.openbrowse exists.
  window.parent.postMessage({ type: "ART_SHIM_READY" }, "*");
})();
`;
