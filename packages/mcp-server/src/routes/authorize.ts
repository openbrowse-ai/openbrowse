import type { ClientRegistry } from "../oauth/clients";
import type { PendingConsents } from "../oauth/pending-consents";
import type { CodeStore } from "../oauth/codes";

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
}

export type AuthorizeResult =
  | { kind: "html"; body: string }
  | { kind: "error"; status: 400; message: string }
  /** OAuth-spec error redirect back to the client's redirect_uri
   *  (RFC 6749 §4.1.2.1) — only used for loopback redirect URIs. */
  | { kind: "redirect"; status: 302; location: string }
  /** Human-facing recovery page for an unknown client_id when no safe
   *  error redirect is possible. Rendered as HTML with status 400. */
  | { kind: "error_page"; status: 400; body: string };

const AUTO_APPROVE_MS = 1000;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export interface HandleAuthorizeArgs {
  params: AuthorizeParams;
  clients: ClientRegistry;
  pending: PendingConsents;
  codes: CodeStore;
  /** When true (default), the page auto-redirects after 1s. Phase 2 sets
   *  this false once the extension content script handles consent. */
  autoApprove?: boolean;
}

/**
 * True when a redirect_uri is a plain-HTTP loopback URL — the shape used by
 * OAuth 2.1 native-app / PKCE flows (RFC 8252 §7.3). Only these get an
 * error redirect for unknown client_ids: redirecting errors to an
 * UNVALIDATED redirect_uri is an open-redirect hazard (RFC 6749 §4.1.2.1
 * requires the AS to NOT redirect when the client identity can't be
 * verified), but a loopback URL can only reach a listener on the user's own
 * machine, so the hazard doesn't apply and the redirect lets well-behaved
 * hosts auto-recover by re-registering.
 */
function isLoopbackRedirect(redirect_uri: string): boolean {
  try {
    const u = new URL(redirect_uri);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function unknownClientPage(client_id: string): string {
  const id = escapeHtml(client_id);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenBrowse — Client not recognized</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 32px; line-height: 1.5; color: #111; }
@media (prefers-color-scheme: dark) {
  body { background: #0a0a0a; color: #e5e5e5; }
  .box { border-color: #2a2a2a; background: #141414; }
  .note { color: #888; }
  code { background: #1f1f1f; }
}
.box { border: 1px solid #ddd; border-radius: 8px; padding: 24px; background: #fafafa; }
h1 { margin-top: 0; font-size: 18px; }
code { background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
.note { color: #666; font-size: 13px; margin-top: 16px; }
</style></head>
<body><div class="box">
<h1>This app needs to reconnect to OpenBrowse</h1>
<p>OpenBrowse doesn't recognize the app that opened this page. This can
happen if OpenBrowse was reinstalled or its local state was reset since the
app first connected.</p>
<p><strong>To fix it:</strong> go back to the app (your MCP host) and
re-authenticate with OpenBrowse. Most hosts re-register automatically when
you retry the connection.</p>
<p class="note">Details for debugging: unknown client_id <code>${id}</code></p>
</div></body></html>`;
}

export function handleAuthorize({
  params,
  clients,
  pending,
  codes,
  autoApprove = true,
}: HandleAuthorizeArgs): AuthorizeResult {
  const client = clients.get(params.client_id);
  if (!client) {
    // RFC 6749 §4.1.2.1: when the client_id is invalid the AS "MUST NOT
    // automatically redirect the user-agent to the invalid redirection URI"
    // — because the redirect_uri is unvalidated. Exception carved out here:
    // plain-HTTP loopback URIs can only reach the user's own machine, so we
    // redirect with `error=invalid_client` to let native hosts detect the
    // stale registration and re-register via DCR without user intervention.
    if (isLoopbackRedirect(params.redirect_uri)) {
      const cb = new URL(params.redirect_uri);
      cb.searchParams.set("error", "invalid_client");
      cb.searchParams.set(
        "error_description",
        "client_id not recognized; re-register via dynamic client registration",
      );
      if (params.state) cb.searchParams.set("state", params.state);
      return { kind: "redirect", status: 302, location: cb.toString() };
    }
    return {
      kind: "error_page",
      status: 400,
      body: unknownClientPage(params.client_id),
    };
  }
  // Exact-string match per RFC 6749 §3.1.2.3 / OAuth 2.1 §1.4.2 — no normalization.
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return {
      kind: "error",
      status: 400,
      message: `redirect_uri not registered: ${params.redirect_uri}`,
    };
  }
  if (params.response_type !== "code") {
    return {
      kind: "error",
      status: 400,
      message: `unsupported response_type: ${params.response_type}`,
    };
  }
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return {
      kind: "error",
      status: 400,
      message: "PKCE required (code_challenge with S256)",
    };
  }

  pending.create(params);
  const code = codes.issue({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    scope: params.scope,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    resource: params.resource,
    state: params.state,
  });
  // LRU bookkeeping: mark the client as recently used only after all
  // validations passed. Failed authorize attempts (bad redirect_uri, bad
  // PKCE, …) must not refresh a client's eviction clock.
  clients.touch(params.client_id);

  const callbackUrl = new URL(params.redirect_uri);
  callbackUrl.searchParams.set("code", code);
  if (params.state) callbackUrl.searchParams.set("state", params.state);

  const scopes = params.scope.split(/\s+/).filter(Boolean);
  const scopeDescriptions = scopes.map(describeScope);
  const friendlyName = escapeHtml(client.client_name ?? client.client_id);

  const body = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenBrowse — Allow ${friendlyName}?</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 32px; line-height: 1.5; color: #111; }
@media (prefers-color-scheme: dark) {
  body { background: #0a0a0a; color: #e5e5e5; }
  .box { border-color: #2a2a2a; background: #141414; }
  .note { color: #888; }
}
.box { border: 1px solid #ddd; border-radius: 8px; padding: 24px; background: #fafafa; }
h1 { margin-top: 0; font-size: 18px; }
.lede { margin: 8px 0 16px 0; }
.permissions { margin: 12px 0 20px 0; padding-left: 20px; }
.permissions li { margin: 6px 0; }
.note { color: #666; font-size: 13px; margin-top: 16px; }
.warning { color: #b45309; font-size: 13px; margin-top: 12px; }
.progress { color: #0a7; font-weight: 500; margin-top: 16px; }
[data-openbrowse-consent] { display: none; }  /* extension content script unhides */
button[data-action] { padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: white; cursor: pointer; font-size: 14px; margin-right: 8px; }
button[data-action="allow"] { background: #059669; color: white; border-color: #059669; }
button[data-action="deny"] { background: white; }
</style></head>
<body><div class="box" data-openbrowse-authorize
  data-client-id="${escapeHtml(params.client_id)}"
  data-client-name="${escapeHtml(client.client_name ?? "")}"
  data-state="${escapeHtml(params.state)}"
  data-scope="${escapeHtml(params.scope)}"
  data-redirect-url="${escapeHtml(callbackUrl.toString())}">
<h1>Allow ${friendlyName} to use OpenBrowse?</h1>
<p class="lede">${friendlyName} is requesting permission to take actions in your browser through OpenBrowse. If you allow this, ${friendlyName} can:</p>
<ul class="permissions">${scopeDescriptions
    .map((d) => `<li>${escapeHtml(d)}</li>`)
    .join("")}</ul>
<p class="warning">Only allow this if you trust ${friendlyName}. You can change or revoke access at any time in OpenBrowse Settings → MCP Server.</p>
<p class="progress" data-openbrowse-status>Waiting for your decision…</p>
<div data-openbrowse-consent>
  <button data-action="allow">Allow</button>
  <button data-action="deny">Deny</button>
</div>
</div>
<script>
${
  autoApprove
    ? `
// Phase 1 fallback auto-approval — replaced by extension content script in Phase 2.
setTimeout(() => {
  document.querySelector("[data-openbrowse-status]").textContent = "Redirecting…";
  window.location.replace(${JSON.stringify(callbackUrl.toString())});
}, ${AUTO_APPROVE_MS});
`
    : `// Consent handled by extension content script.`
}
</script>
</body></html>`;

  return { kind: "html", body };
}

/**
 * Map a raw scope token to a plain-English description of the access it
 * grants. Mirrors the canonical tool→scope map in
 * `packages/mcp-server/src/mcp/tools.ts` so users see the same set of
 * permissions on the authorise page that the broker will actually
 * enforce.
 *
 * Unknown scopes pass through verbatim so a future scope name (added
 * without updating this mapping) still surfaces *something* in the UI
 * rather than being silently hidden. Better to show "experimental_x"
 * than to lie by omission about what was requested.
 */
function describeScope(scope: string): string {
  switch (scope) {
    case "list_windows":
      return "See your browser windows and tabs";
    case "list_spaces":
      return "See your OpenBrowse spaces";
    case "get_context":
      return "See information about your current browser state";
    case "read_page":
      return "Read the contents of pages you're viewing";
    case "screenshot":
      return "Take screenshots of pages";
    case "open_url":
      return "Open URLs and navigate pages in your browser";
    case "task":
      return "Run multi-step automated tasks in your browser";
    case "cancel_task":
      return "Cancel its own running tasks";
    default:
      return scope;
  }
}
