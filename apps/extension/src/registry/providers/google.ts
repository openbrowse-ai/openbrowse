import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "google",
  name: "Gemini",
  icon: { light: "google.svg" },
  description: "Gemini 3.x and 2.5 multimodal models",
  setup: "byok",
  configSchema: [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder: "AI...",
    },
  ],
  models: [
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      description: "Latest flagship with deep reasoning and long context",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "high",
      speed: "medium",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: { inputPer1M: 2, outputPer1M: 12 },
    },
    {
      id: "gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      description: "Ultra-fast and cheap for lightweight tasks",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "low",
      speed: "fast",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: { inputPer1M: 0.25, outputPer1M: 1.50 },
    },
    {
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash",
      description: "Fast multimodal model with strong reasoning",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "medium",
      speed: "fast",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: { inputPer1M: 0.50, outputPer1M: 3 },
    },
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      description: "Previous-gen pro with thinking and long context",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "high",
      speed: "medium",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: { inputPer1M: 1.25, outputPer1M: 10 },
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      description: "Fast and affordable with thinking capabilities",
      capabilities: ["chat", "tools", "vision", "thinking"],
      intelligence: "medium",
      speed: "fast",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: { inputPer1M: 0.30, outputPer1M: 2.50 },
    },
  ],
  createLanguageModel(config, modelId) {
    const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
    return google(modelId);
  },
};
