import { createAnthropicCuaProvider } from "./anthropic";
import { isAnthropicComputerUseModel } from "./model-ids";
import type { CuaProvider } from "./provider";

/**
 * Resolve a CUA provider strategy for a given registry provider id + model id.
 *
 * Supported transports in Phase 1:
 *   - `anthropic` (direct): any configured Anthropic key. The model id is a
 *     direct id like `claude-sonnet-4-6`.
 *   - `vercel` (Vercel AI Gateway): only Anthropic Claude computer-use models,
 *     whose ids look like `anthropic/claude-sonnet-4.6`. The gateway is the
 *     transport; the `computer_*` tool is still built from `@ai-sdk/anthropic`
 *     (the gateway forwards the provider-defined tool). The loop runs against
 *     the gateway-routed model, so `config.apiKey` here only mints the tool
 *     descriptor, not the transport call.
 *
 * Other providers (and non-Claude gateway models) throw a clear error.
 */
export function resolveCuaProvider(
  providerId: string,
  modelId: string,
  config: Record<string, string>,
): CuaProvider {
  if (providerId === "anthropic") {
    if (!config.apiKey)
      throw new Error("Anthropic CUA requires an apiKey in provider config.");
    return createAnthropicCuaProvider(config.apiKey);
  }

  if (providerId === "vercel") {
    if (!isAnthropicComputerUseModel(modelId)) {
      throw new Error(
        `Computer use via the AI Gateway requires an Anthropic Claude computer-use model ` +
          `(e.g. "anthropic/claude-sonnet-4.6"); got "${modelId}".`,
      );
    }
    if (!config.apiKey)
      throw new Error("Gateway CUA requires an apiKey in provider config.");
    // The gateway key mints the Anthropic-defined computer tool; the actual
    // generation runs against the gateway model passed into runLoop.
    return createAnthropicCuaProvider(config.apiKey);
  }

  throw new Error(
    `Computer use is not supported for provider '${providerId}' yet ` +
      `(Phase 1 supports Anthropic direct and the Vercel AI Gateway with Claude models).`,
  );
}
