/**
 * Hand-extracted fixture providers for mapping tests. Keep these
 * minimal — we want to assert the mapping rules, not duplicate the
 * full snapshot.
 */

import type { ModelsDevProvider } from "../types";

export const ANTHROPIC_FIXTURE: ModelsDevProvider = {
  id: "anthropic",
  name: "Anthropic",
  npm: "@ai-sdk/anthropic",
  env: ["ANTHROPIC_API_KEY"],
  models: {
    "claude-haiku-4-5": {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5 (latest)",
      family: "claude-haiku",
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: true,
      release_date: "2025-10-15",
      last_updated: "2025-10-15",
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      open_weights: false,
      limit: { context: 200_000, output: 64_000 },
      cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
    },
    "claude-3-opus-20240229": {
      id: "claude-3-opus-20240229",
      name: "Claude Opus 3",
      family: "claude-opus",
      attachment: true,
      reasoning: false,
      tool_call: true,
      temperature: true,
      release_date: "2024-02-29",
      last_updated: "2024-02-29",
      modalities: { input: ["text", "image"], output: ["text"] },
      open_weights: false,
      limit: { context: 200_000, output: 4096 },
      cost: { input: 15, output: 75 },
      status: "deprecated",
    },
    "claude-experimental-alpha": {
      id: "claude-experimental-alpha",
      name: "Claude Experimental",
      attachment: false,
      reasoning: false,
      tool_call: false,
      release_date: "2026-01-01",
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 200_000, output: 4096 },
      status: "alpha",
    },
  },
};

export const UNSUPPORTED_FIXTURE: ModelsDevProvider = {
  id: "atomic-chat",
  name: "Atomic Chat",
  npm: "@atomic/some-unbundled-sdk",
  env: ["ATOMIC_API_KEY"],
  models: {
    foo: {
      id: "foo",
      name: "Foo",
      release_date: "2025-01-01",
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 8192, output: 2048 },
    },
  },
};

export const OPENAI_COMPATIBLE_FIXTURE: ModelsDevProvider = {
  id: "groq",
  name: "Groq",
  npm: "@ai-sdk/openai-compatible",
  api: "https://api.groq.com/openai/v1",
  env: ["GROQ_API_KEY"],
  models: {
    "llama-3.3-70b-versatile": {
      id: "llama-3.3-70b-versatile",
      name: "Llama 3.3 70B Versatile",
      family: "llama",
      attachment: false,
      reasoning: false,
      tool_call: true,
      release_date: "2024-12-06",
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128_000, output: 32_768 },
      cost: { input: 0.59, output: 0.79 },
    },
  },
};
