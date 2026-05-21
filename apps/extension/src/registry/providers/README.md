# Provider Registry

The provider registry defines LLM providers available in OpenBrowse. Each provider specifies its configuration (API keys, endpoints), available models with capabilities and pricing, and a factory function to create AI SDK language model instances.

## Adding a new provider

### 1. Create the definition file

Create `src/registry/providers/{id}.ts`:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "my-provider",
  name: "My Provider",
  icon: { light: "my-provider.svg" },
  description: "One-line summary of what this provider offers",
  setup: "byok",
  configSchema: [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder: "sk-...",
    },
  ],
  models: [
    {
      id: "my-model-large",
      name: "My Model Large",
      description: "Flagship model with strong reasoning",
      capabilities: ["chat", "tools", "vision"],
      intelligence: "high",
      speed: "medium",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    },
    {
      id: "my-model-small",
      name: "My Model Small",
      capabilities: ["chat", "tools"],
      intelligence: "medium",
      speed: "fast",
      contextWindow: 32_000,
      maxOutputTokens: 8_192,
      pricing: { inputPer1M: 0.5, outputPer1M: 2 },
    },
  ],
  createLanguageModel(config, modelId) {
    const provider = createOpenAI({
      baseURL: "https://api.my-provider.com/v1",
      apiKey: config.apiKey,
    });
    return provider(modelId);
  },
};
```

### 2. Add an icon

Place your SVG at `src/registry/providers/icons/{id}.svg`.

- Square SVG (16×16 or 24×24 viewBox)
- For dark mode, add `{id}-dark.svg` and set `icon: { light: "{id}.svg", dark: "{id}-dark.svg" }`

Register it in `src/components/ui/registry-icon.tsx`:

```ts
import myProviderSvg from "@/registry/providers/icons/my-provider.svg?raw";

// Add to the icons record:
"my-provider": { light: myProviderSvg },
```

### 3. Register the provider

In `src/registry/providers/index.ts`:

```ts
import { definition as myProvider } from "./my-provider";

export const providers: ProviderDefinition[] = [
  // ... existing providers
  myProvider,
];
```

### 4. Verify TypeScript compiles

```sh
npx tsc --noEmit
```

## Setup modes

| Mode           | Description                                                      | Example                   |
| -------------- | ---------------------------------------------------------------- | ------------------------- |
| `"byok"`       | User provides API key / endpoint. Most cloud providers use this. | OpenAI, Anthropic, Ollama |
| `"browser-ai"` | Uses Chrome's built-in AI APIs. No user config needed.           | Built-in AI (Gemini Nano) |
| `"web-llm"`    | Downloads and runs models locally via WebGPU.                    | WebLLM                    |

For `"byok"` providers, define `configSchema` with the fields the user needs to fill in. The `config` object passed to `createLanguageModel` is keyed by `ConfigField.key`.

## Model capabilities

Each model declares which features it supports:

| Capability   | Meaning                                           |
| ------------ | ------------------------------------------------- |
| `"chat"`     | Basic text generation (all models must have this) |
| `"tools"`    | Function/tool calling support                     |
| `"vision"`   | Image input support                               |
| `"thinking"` | Extended thinking / chain-of-thought              |

The UI uses these to filter models (e.g. only showing tool-capable models for agent mode).

## `createLanguageModel`

This factory is called when the user starts a chat with this provider + model. It receives:

- `config` — the user's saved configuration values (API keys, base URLs, etc.)
- `modelId` — the selected `ModelDefinition.id`

It must return an AI SDK `LanguageModel` instance. Most providers can use `@ai-sdk/openai` (for OpenAI-compatible APIs) or their dedicated SDK (`@ai-sdk/anthropic`, `@ai-sdk/google`, etc.).

For providers that handle model loading differently (browser-ai, web-llm), `createLanguageModel` throws — those models are instantiated through their respective runtime APIs in the offscreen document.

## File structure

```
src/registry/providers/
├── README.md              ← you are here
├── types.ts               ← ProviderDefinition, ModelDefinition, etc.
├── index.ts               ← registry array + lookup function
├── icons/                 ← SVG icons ({id}.svg, optional {id}-dark.svg)
│   ├── openai.svg
│   ├── openai-dark.svg
│   └── ...
├── openai.ts              ← one file per provider
├── anthropic.ts
├── google.ts
├── ollama.ts
├── openai-compatible.ts
├── browser-ai.ts
└── web-llm.ts
```

## Guidelines

- **One file per provider** — keeps diffs clean and ownership clear.
- **Keep model lists current** — update pricing and model IDs when providers release new versions.
- **Use the AI SDK** — all providers must return a standard `LanguageModel` from the [Vercel AI SDK](https://sdk.vercel.ai/docs). This ensures consistent tool calling, streaming, and thinking support.
- **Mark capabilities accurately** — don't mark `"tools"` unless you've verified the model handles tool calls correctly through the AI SDK.
- **Omit `pricing` for local models** — Ollama, WebLLM, and browser-ai models are free to run.
- **Use `downloadSize` for local models** — helps users decide which model to download.
