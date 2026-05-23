/**
 * Per-provider image size caps for inline vision message parts.
 *
 * Values reflect provider-published API limits as of 2026-05. Maintenance
 * note: caps move maybe once a year. Update this table when they do — it
 * is the single source of truth.
 *
 * Universal hard ceiling regardless of provider: 20 MB. Even if a provider
 * accepts more, base64 inflation (~33%) means a 25 MB image becomes a
 * 33 MB blob in the message stream, bloating compaction.
 */

const PROVIDER_CAPS_MB: Record<string, number> = {
  anthropic: 5,
  google: 7,
  xai: 10,
  openai: 20,
  "openai-compat": 10,
  openrouter: 5, // defensive — request can route to any underlying model
  ollama: 10,
  webllm: 10,
  "chrome-builtin": 10,
};

const HARD_CEILING_MB = 20;
const DEFAULT_MB = 10;

/**
 * Returns the maximum image size (in bytes) that should be inlined as a
 * vision message part for the given model. Files above this cap can still
 * land in the workspace; they just won't be sent as vision parts.
 *
 * Accepts the compound `<provider>:<modelId>` key used throughout the
 * registry (and `ChatInput.selectedModel`). If no colon is present the
 * entire string is treated as the provider id.
 */
export function getImageSizeLimit(modelKey: string): number {
  const provider = modelKey.includes(":")
    ? modelKey.slice(0, modelKey.indexOf(":"))
    : modelKey;
  const cap = PROVIDER_CAPS_MB[provider] ?? DEFAULT_MB;
  return Math.min(cap, HARD_CEILING_MB) * 1024 * 1024;
}
