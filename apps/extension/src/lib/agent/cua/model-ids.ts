/**
 * Shared helpers for recognizing Anthropic Claude computer-use models across
 * the two id conventions we encounter:
 *
 *   - Direct Anthropic provider: `claude-sonnet-4-6` (hyphen versions).
 *   - Vercel AI Gateway provider: `anthropic/claude-sonnet-4.6` (an
 *     `anthropic/` prefix and DOT versions).
 *
 * Both `anthropicToolSpec` (tool version / beta header selection) and the
 * registry capability flagging consume these so the two id forms never drift
 * apart.
 */

/**
 * Normalize a model id for matching: lowercase, strip a leading provider
 * prefix (e.g. `anthropic/`), and treat `.` and `-` as equivalent version
 * separators. So both `claude-sonnet-4-6` and `anthropic/claude-sonnet-4.6`
 * normalize to `claude-sonnet-4-6`.
 */
export function normalizeModelId(modelId: string): string {
  const withoutPrefix = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  return withoutPrefix.toLowerCase().replace(/\./g, "-");
}

/**
 * True when the (normalized) model id is an Anthropic Claude model that
 * supports the computer-use tool: Sonnet 4.5/4.6, Haiku 4.5, Opus 4.5–4.8.
 */
export function isAnthropicComputerUseModel(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  if (!id.includes("claude")) return false;
  return (
    /sonnet-4-(5|6)/.test(id) ||
    /haiku-4-5/.test(id) ||
    /opus-4-(5|6|7|8)/.test(id)
  );
}

/**
 * True when the (normalized) model id is a "new generation" computer-use
 * model that uses `computer_20251124` + the `computer-use-2025-11-24` beta:
 * Sonnet 4.6 and Opus 4.5–4.8. Older CUA models (Sonnet 4.5, Haiku 4.5) use
 * the 2025-01-24 generation.
 */
export function isNewGenComputerUseModel(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  return /sonnet-4-6/.test(id) || /opus-4-(5|6|7|8)/.test(id);
}
