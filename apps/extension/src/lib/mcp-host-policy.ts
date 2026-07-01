export type HostPolicy = "always-prompt" | "auto-allow" | "blocked";
export type ConfirmationOutcome = "auto" | "prompt" | "host_blocked";

const STORAGE_KEY = "mcp_host_policies";

/**
 * Default policy applied to MCP hosts that have no stored override.
 *
 * `auto-allow` rationale: the OAuth `/authorize` page is the user's
 * primary consent step. Once a host completes OAuth, asking for
 * per-action confirmation on every subsequent tool call is friction
 * with little additional safety value (the OAuth grant already
 * enumerates the scopes the host can call). Users who want extra
 * friction can downgrade individual hosts to `always-prompt` via the
 * Settings → MCP Server UI, and the global `Always confirm before AI
 * tasks run` preference forces all hosts to `always-prompt` regardless
 * of per-host setting.
 *
 * A host can also opt INTO a prompt for a specific call by setting
 * `confirmation: "prompt"` in the tool args — `resolveConfirmation`
 * honours that (more-friction wins).
 *
 * The previous default was `always-prompt`. Existing stored policies
 * are preserved by the read-before-default logic in `getPolicy`.
 */
const DEFAULT_POLICY: HostPolicy = "auto-allow";

async function readMap(): Promise<Record<string, HostPolicy>> {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  return (obj[STORAGE_KEY] as Record<string, HostPolicy> | undefined) ?? {};
}

async function writeMap(map: Record<string, HostPolicy>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

export async function getPolicy(clientId: string): Promise<HostPolicy> {
  const map = await readMap();
  return map[clientId] ?? DEFAULT_POLICY;
}

export async function setPolicy(clientId: string, policy: HostPolicy): Promise<void> {
  const map = await readMap();
  map[clientId] = policy;
  await writeMap(map);
}

export async function listPolicies(): Promise<Record<string, HostPolicy>> {
  return readMap();
}

/**
 * Combine the user's stored policy with the host's per-task request.
 * Returns the resolved outcome:
 *   - "auto":         allow without prompting the user
 *   - "prompt":       block on user Allow/Deny prompt
 *   - "host_blocked": fail the task immediately with host_blocked error
 *
 * Per spec: more friction wins. A host can ask for more confirmation than
 * the user requires, but never less.
 *
 * A corrupt/unknown stored policy value falls through to the same
 * "auto" default as a fresh host. Failing open here is a deliberate
 * choice: under the OAuth-is-consent model, the equivalent of the
 * pre-2026-06-29 fail-closed behaviour is the user's explicit
 * `always-prompt` opt-in. A corrupt value should not silently demote a
 * host the user previously chose to trust.
 */
export async function resolveConfirmation(
  clientId: string,
  hostRequest: "auto" | "prompt",
): Promise<ConfirmationOutcome> {
  const policy = await getPolicy(clientId);
  if (policy === "blocked") return "host_blocked";
  if (policy === "always-prompt") return "prompt";
  // `auto-allow` (default) and any unknown/corrupt value: respect
  // host's more-restrictive request.
  return hostRequest === "prompt" ? "prompt" : "auto";
}
