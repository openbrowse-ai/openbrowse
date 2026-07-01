import type { ConsentGrantedMessage, ConsentDeniedMessage } from "./protocol";

export interface ConsentDecisionArgs {
  decision: "allow" | "deny";
  state: string;
  /** The URL the page should redirect to on Allow (built by the broker with ?code=...&state=...). */
  redirectUrlWithCode: string;
  /** The active broker WS; null if we're offline. */
  ws: WebSocket | null;
}

export interface ConsentDecisionResult {
  ok: boolean;
  redirectUrl: string;
}

/**
 * Handle the user's Allow/Deny decision on the broker's /authorize consent
 * page. Sends a `consent-granted` or `consent-denied` over WS to the broker
 * (best-effort; non-fatal if WS is null or send fails), and returns the URL
 * the page should navigate to.
 *
 * On Allow: returns `redirectUrlWithCode` unchanged — the broker already
 * embedded the `?code=...&state=...` params.
 *
 * On Deny: strips the `code` param and substitutes
 * `?error=access_denied&error_description=...`. If `redirectUrlWithCode`
 * is malformed, returns it unchanged with `ok: false`.
 *
 * Precondition: `redirectUrlWithCode` MUST be a valid absolute URL
 * (the broker constructs it). The function is defensive against malformed
 * input but cannot recover — callers should treat `ok: false` as an
 * indication the redirect URL is unsafe to navigate to.
 */
export async function handleConsentDecision(args: ConsentDecisionArgs): Promise<ConsentDecisionResult> {
  const { decision, state, redirectUrlWithCode, ws } = args;

  if (decision === "allow") {
    if (ws) {
      const msg: ConsentGrantedMessage = { type: "consent-granted", state };
      try { ws.send(JSON.stringify(msg)); } catch { /* broker may have disconnected; non-fatal */ }
    }
    return { ok: true, redirectUrl: redirectUrlWithCode };
  }

  // deny — strip the code from the redirect URL and substitute error=access_denied
  let url: URL;
  try {
    url = new URL(redirectUrlWithCode);
  } catch {
    console.warn("[mcp-bridge/consent] malformed redirectUrlWithCode, passing through unchanged:", redirectUrlWithCode);
    return { ok: false, redirectUrl: redirectUrlWithCode };
  }
  url.searchParams.delete("code");
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "User declined consent in the OpenBrowse extension.");

  if (ws) {
    const msg: ConsentDeniedMessage = { type: "consent-denied", state, reason: "user_denied" };
    try { ws.send(JSON.stringify(msg)); } catch { /* non-fatal */ }
  }
  return { ok: true, redirectUrl: url.toString() };
}
