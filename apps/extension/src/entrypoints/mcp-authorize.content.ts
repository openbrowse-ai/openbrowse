import { defineContentScript } from "wxt/utils/define-content-script";

export async function main(): Promise<void> {
  const root = document.querySelector(
    "[data-openbrowse-authorize]",
  ) as HTMLElement | null;
  if (!root) return;

  const consent = root.querySelector(
    "[data-openbrowse-consent]",
  ) as HTMLElement | null;
  const status = root.querySelector(
    "[data-openbrowse-status]",
  ) as HTMLElement | null;
  if (consent) consent.style.display = "block";

  const state = root.dataset.state ?? "";
  const redirectUrl = root.dataset.redirectUrl ?? "";

  // Tell background the page loaded — used for audit logging.
  void Promise.resolve(
    chrome.runtime.sendMessage({
      type: "MCP_BRIDGE_AUTHORIZE_PAGE_LOADED",
      clientId: root.dataset.clientId,
      clientName: root.dataset.clientName,
      scope: root.dataset.scope,
      state,
    }),
  ).catch(() => {});

  async function decide(decision: "allow" | "deny"): Promise<void> {
    if (status) status.textContent = decision === "allow" ? "Granting…" : "Denying…";
    const reply = (await chrome.runtime.sendMessage({
      type: "MCP_BRIDGE_CONSENT_DECISION",
      decision,
      state,
      redirectUrlWithCode: redirectUrl,
    })) as { ok: boolean; redirectUrl?: string };
    if (reply?.ok && reply.redirectUrl) {
      window.location.replace(reply.redirectUrl);
    } else if (status) {
      status.textContent = "Error contacting OpenBrowse. Please retry.";
    }
  }

  const allowBtn = root.querySelector(
    '[data-action="allow"]',
  ) as HTMLButtonElement | null;
  const denyBtn = root.querySelector(
    '[data-action="deny"]',
  ) as HTMLButtonElement | null;
  allowBtn?.addEventListener("click", () => void decide("allow"));
  denyBtn?.addEventListener("click", () => void decide("deny"));
}

export default defineContentScript({
  matches: [
    "http://localhost:47821/authorize*",
    "http://127.0.0.1:47821/authorize*",
  ],
  runAt: "document_idle",
  main,
});
