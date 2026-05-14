import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "anthropic",
  name: "Anthropic",
  icon: { light: "anthropic.svg", dark: "anthropic-dark.svg" },
  description: "Claude Opus 4.7, Sonnet, and Haiku models with extended thinking",
  setup: "byok",
  configSchema: [
    { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-ant-..." },
  ],
  models: [
    {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      description: "Most capable model for complex tasks requiring deep reasoning",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "high",
      speed: "slow",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { inputPer1M: 5, outputPer1M: 25 },
    },
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      description: "Previous flagship with strong reasoning and coding",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "high",
      speed: "slow",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { inputPer1M: 5, outputPer1M: 25 },
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      description: "Best balance of speed and intelligence for most tasks",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "high",
      speed: "medium",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    },
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      description: "Previous-gen Sonnet with strong general performance",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "medium",
      speed: "medium",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    },
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      description: "Fast and affordable for simple tasks and high-volume use",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "medium",
      speed: "fast",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: { inputPer1M: 1, outputPer1M: 5 },
    },
  ],
  createLanguageModel(config, modelId) {
    const anthropic = createAnthropic({
      apiKey: config.apiKey,
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    });
    return anthropic(modelId);
  },
};
