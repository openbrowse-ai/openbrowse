/**
 * Pure tab-cleanup policy decision logic.
 *
 * Bundle-safe: this module imports NOTHING from chrome-API or chat-db
 * or storage. The settings page imports from here directly (see
 * `entrypoints/settings/mcp-bridge/TabCleanupPolicySelect.tsx`); the
 * background entrypoint composes this with the runtime layer in
 * `cleanup-runtime.ts`.
 *
 * Three policies:
 *   - "always-close" (default): close tabs on any terminal outcome.
 *     Mental model: "MCP is a remote API — clean up after every call."
 *     The full chat transcript persists in chat-db so users can review
 *     what the agent did even after tabs are gone.
 *   - "close-on-cancel-only": only close tabs when the user/host
 *     explicitly cancels. Successful + errored runs leave their tabs
 *     open for review.
 *   - "keep": never auto-close. Escape hatch for debugging.
 *
 * Migration from the legacy `mcpKeepTabsAfterCancel` boolean:
 *   - `true`  → "keep"
 *   - `false` or unset → "always-close" (intentional behavior change:
 *     previously `false` meant "close-on-cancel-only"; the new default
 *     is more aggressive because successful + errored tasks used to
 *     leak tabs forever).
 */

export type TabCleanupPolicy =
  | "always-close"
  | "close-on-cancel-only"
  | "keep";

export type TabCleanupOutcome = "completed" | "errored" | "cancelled";

/**
 * Pure decision: given a policy and an outcome, should we close the
 * agent's tabs? Exported for unit testing.
 */
export function decideTabCleanup(
  policy: TabCleanupPolicy,
  outcome: TabCleanupOutcome,
): boolean {
  switch (policy) {
    case "always-close":
      return true;
    case "close-on-cancel-only":
      return outcome === "cancelled";
    case "keep":
      return false;
  }
}

/**
 * Read the effective policy from a settings snapshot, applying the
 * legacy-field migration. Pure: takes the minimal subset of settings
 * fields it needs so callers can keep tests cheap.
 */
export function resolveTabCleanupPolicy(s: {
  mcpAfterTaskTabPolicy?: TabCleanupPolicy;
  mcpKeepTabsAfterCancel?: boolean;
}): TabCleanupPolicy {
  if (s.mcpAfterTaskTabPolicy !== undefined) return s.mcpAfterTaskTabPolicy;
  if (s.mcpKeepTabsAfterCancel === true) return "keep";
  return "always-close";
}
