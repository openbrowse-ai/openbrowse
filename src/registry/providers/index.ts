import { definition as openai } from "./openai";
import { definition as anthropic } from "./anthropic";
import { definition as google } from "./google";
import { definition as ollama } from "./ollama";
import { definition as openaiCompatible } from "./openai-compatible";
import { definition as browserAi } from "./browser-ai";
import { definition as webLlm } from "./web-llm";
import type { ProviderDefinition } from "./types";

export const providers: ProviderDefinition[] = [
  browserAi,
  webLlm,
  openai,
  anthropic,
  google,
  ollama,
  openaiCompatible,
];

export function getProvider(id: string): ProviderDefinition | undefined {
  return providers.find((p) => p.id === id);
}

export type { ProviderDefinition, ConfigField, ModelDefinition } from "./types";
