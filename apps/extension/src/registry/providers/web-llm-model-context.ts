// AUTO-DERIVED — do not hand-edit the numeric values.
//
// Each model's real context window is read from its own
// `mlc-chat-config.json` (`context_window_size`, or `sliding_window_size`
// for sliding-window models), fetched from the model's Hugging Face repo.
// This is the source of truth that overrides mlc's conservative prebuilt
// `overrides.context_window_size: 4096` default.
//
// The prebuilt WASM libs are NOT context-capped: `@mlc-ai/web-llm` reads
// only `prefill_chunk_size` from the compiled lib; `context_window_size` is
// a runtime KV-cache ceiling (paged cache grows on demand, no load-time
// cost), overridable via
// `engineConfig.appConfig.model_list[].overrides.context_window_size`
// (verified empirically at 131072 on Apple metal-3).
//
// Regenerate: for each id in `prebuiltAppConfig.model_list`, fetch
// `<model>/resolve/main/mlc-chat-config.json` and read the window fields.

export interface WebLLMModelContext {
  /** Effective usable context window (sourced from the model config). */
  contextWindow: number;
  /**
   * Value to write into `overrides.context_window_size` when loading. When
   * omitted, the model uses a native sliding window and must not be
   * overridden.
   */
  overrideContextWindowSize?: number;
  /** `prefill_chunk_size` from the compiled lib / model config. */
  prefillChunkSize?: number;
  /** True when the model relies on a native sliding window. */
  slidingWindow: boolean;
  /** Approximate VRAM needed for weights (from the prebuilt entry). */
  vramRequiredMB?: number;
  /** True when the prebuilt entry flags it as low-resource. */
  lowResource: boolean;
}

export const WEB_LLM_MODEL_CONTEXT: Record<string, WebLLMModelContext> = {
  "DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5001.0, lowResource: false },
  "DeepSeek-R1-Distill-Llama-8B-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 6101.01, lowResource: false },
  "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5106.67, lowResource: false },
  "DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5900.09, lowResource: false },
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 4976.13, lowResource: false },
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 6051.27, lowResource: false },
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC": { contextWindow: 4096, prefillChunkSize: 2048, slidingWindow: true, vramRequiredMB: 4033.28, lowResource: false },
  "Hermes-2-Theta-Llama-3-8B-q4f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 4976.13, lowResource: false },
  "Hermes-2-Theta-Llama-3-8B-q4f32_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 6051.27, lowResource: false },
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 4876.13, lowResource: false },
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5779.27, lowResource: false },
  "Hermes-3-Llama-3.2-3B-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2263.69, lowResource: true },
  "Hermes-3-Llama-3.2-3B-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2951.51, lowResource: true },
  "Llama-2-13b-chat-hf-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 11814.09, lowResource: false },
  "Llama-2-7b-chat-hf-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 6749.02, lowResource: false },
  "Llama-2-7b-chat-hf-q4f16_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 4618.52, lowResource: false },
  "Llama-2-7b-chat-hf-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 9109.03, lowResource: false },
  "Llama-2-7b-chat-hf-q4f32_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 5284.01, lowResource: false },
  "Llama-3-70B-Instruct-q3f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 1024, slidingWindow: false, vramRequiredMB: 31153.13, lowResource: false },
  "Llama-3-8B-Instruct-q4f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5001.0, lowResource: false },
  "Llama-3-8B-Instruct-q4f16_1-MLC-1k": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 4598.34, lowResource: true },
  "Llama-3-8B-Instruct-q4f32_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 6101.01, lowResource: false },
  "Llama-3-8B-Instruct-q4f32_1-MLC-1k": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5295.7, lowResource: true },
  "Llama-3.1-70B-Instruct-q3f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 31153.13, lowResource: false },
  "Llama-3.1-8B-Instruct-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5001.0, lowResource: false },
  "Llama-3.1-8B-Instruct-q4f16_1-MLC-1k": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 4598.34, lowResource: true },
  "Llama-3.1-8B-Instruct-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 6101.01, lowResource: false },
  "Llama-3.1-8B-Instruct-q4f32_1-MLC-1k": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5295.7, lowResource: true },
  "Llama-3.2-1B-Instruct-q0f16-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2573.13, lowResource: true },
  "Llama-3.2-1B-Instruct-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 879.04, lowResource: true },
  "Llama-3.2-1B-Instruct-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 1128.82, lowResource: true },
  "Llama-3.2-3B-Instruct-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2263.69, lowResource: true },
  "Llama-3.2-3B-Instruct-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2951.51, lowResource: true },
  "Ministral-3-3B-Base-2512-q4f16_1-MLC": { contextWindow: 262144, overrideContextWindowSize: 262144, prefillChunkSize: 1024, slidingWindow: false, lowResource: false },
  "Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC": { contextWindow: 262144, overrideContextWindowSize: 262144, prefillChunkSize: 1024, slidingWindow: false, lowResource: false },
  "Ministral-3-3B-Reasoning-2512-q4f16_1-MLC": { contextWindow: 262144, overrideContextWindowSize: 262144, prefillChunkSize: 1024, slidingWindow: false, lowResource: false },
  "Mistral-7B-Instruct-v0.2-q4f16_1-MLC": { contextWindow: 4096, prefillChunkSize: 4096, slidingWindow: true, vramRequiredMB: 4573.39, lowResource: false },
  "Mistral-7B-Instruct-v0.3-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 4573.39, lowResource: false },
  "Mistral-7B-Instruct-v0.3-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5619.27, lowResource: false },
  "NeuralHermes-2.5-Mistral-7B-q4f16_1-MLC": { contextWindow: 4096, prefillChunkSize: 4096, slidingWindow: true, vramRequiredMB: 4573.39, lowResource: false },
  "OpenHermes-2.5-Mistral-7B-q4f16_1-MLC": { contextWindow: 4096, prefillChunkSize: 4096, slidingWindow: true, vramRequiredMB: 4573.39, lowResource: false },
  "Phi-3-mini-4k-instruct-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3672.07, lowResource: false },
  "Phi-3-mini-4k-instruct-q4f16_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2520.07, lowResource: true },
  "Phi-3-mini-4k-instruct-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5483.12, lowResource: false },
  "Phi-3-mini-4k-instruct-q4f32_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3179.12, lowResource: true },
  "Phi-3.5-mini-instruct-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3672.07, lowResource: false },
  "Phi-3.5-mini-instruct-q4f16_1-MLC-1k": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2520.07, lowResource: true },
  "Phi-3.5-mini-instruct-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5483.12, lowResource: false },
  "Phi-3.5-mini-instruct-q4f32_1-MLC-1k": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3179.12, lowResource: true },
  "Phi-3.5-vision-instruct-q4f16_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 3952.18, lowResource: true },
  "Phi-3.5-vision-instruct-q4f32_1-MLC": { contextWindow: 131072, overrideContextWindowSize: 131072, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 5879.84, lowResource: true },
  "Qwen2-0.5B-Instruct-q0f16-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1624.12, lowResource: true },
  "Qwen2-0.5B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 944.62, lowResource: true },
  "Qwen2-1.5B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1629.75, lowResource: true },
  "Qwen2-1.5B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1888.97, lowResource: true },
  "Qwen2-7B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5106.67, lowResource: false },
  "Qwen2-7B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5900.09, lowResource: false },
  "Qwen2-Math-1.5B-Instruct-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1629.75, lowResource: true },
  "Qwen2-Math-1.5B-Instruct-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1888.97, lowResource: true },
  "Qwen2-Math-7B-Instruct-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5106.67, lowResource: false },
  "Qwen2-Math-7B-Instruct-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5900.09, lowResource: false },
  "Qwen2.5-0.5B-Instruct-q0f16-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1624.12, lowResource: true },
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 944.62, lowResource: true },
  "Qwen2.5-0.5B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1060.2, lowResource: true },
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1629.75, lowResource: true },
  "Qwen2.5-1.5B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1888.97, lowResource: true },
  "Qwen2.5-3B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2504.76, lowResource: true },
  "Qwen2.5-3B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2893.64, lowResource: true },
  "Qwen2.5-7B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5106.67, lowResource: false },
  "Qwen2.5-7B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5900.09, lowResource: false },
  "Qwen2.5-Coder-0.5B-Instruct-q0f16-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 1624.12, lowResource: true },
  "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 944.62, lowResource: true },
  "Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 1060.2, lowResource: true },
  "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1629.75, lowResource: false },
  "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1888.97, lowResource: false },
  "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2504.76, lowResource: true },
  "Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2893.64, lowResource: true },
  "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5106.67, lowResource: false },
  "Qwen2.5-Coder-7B-Instruct-q4f32_1-MLC": { contextWindow: 32768, overrideContextWindowSize: 32768, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5900.09, lowResource: false },
  "Qwen2.5-Math-1.5B-Instruct-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 1629.75, lowResource: true },
  "Qwen2.5-Math-1.5B-Instruct-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 1888.97, lowResource: true },
  "Qwen3-0.6B-q0f16-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2220.38, lowResource: true },
  "Qwen3-0.6B-q4f16_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1403.34, lowResource: true },
  "Qwen3-0.6B-q4f32_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1924.98, lowResource: true },
  "Qwen3-1.7B-q4f16_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2036.66, lowResource: true },
  "Qwen3-1.7B-q4f32_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2635.44, lowResource: true },
  "Qwen3-4B-q4f16_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3431.59, lowResource: true },
  "Qwen3-4B-q4f32_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 4327.71, lowResource: true },
  "Qwen3-8B-q4f16_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 5695.78, lowResource: false },
  "Qwen3-8B-q4f32_1-MLC": { contextWindow: 40960, overrideContextWindowSize: 40960, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 6852.55, lowResource: false },
  "RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2972.09, lowResource: false },
  "RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2041.09, lowResource: true },
  "RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3928.09, lowResource: false },
  "RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2558.09, lowResource: true },
  "SmolLM2-1.7B-Instruct-q4f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 1774.19, lowResource: true },
  "SmolLM2-1.7B-Instruct-q4f32_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 2692.38, lowResource: true },
  "SmolLM2-135M-Instruct-q0f16-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 359.69, lowResource: true },
  "SmolLM2-135M-Instruct-q0f32-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 719.38, lowResource: true },
  "SmolLM2-360M-Instruct-q0f16-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 871.99, lowResource: true },
  "SmolLM2-360M-Instruct-q0f32-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 1743.99, lowResource: true },
  "SmolLM2-360M-Instruct-q4f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 376.06, lowResource: true },
  "SmolLM2-360M-Instruct-q4f32_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 8192, slidingWindow: false, vramRequiredMB: 579.61, lowResource: true },
  "TinyLlama-1.1B-Chat-v0.4-q4f16_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 697.24, lowResource: true },
  "TinyLlama-1.1B-Chat-v0.4-q4f16_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 675.24, lowResource: true },
  "TinyLlama-1.1B-Chat-v0.4-q4f32_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 839.98, lowResource: true },
  "TinyLlama-1.1B-Chat-v0.4-q4f32_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 795.98, lowResource: true },
  "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 697.24, lowResource: true },
  "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 675.24, lowResource: true },
  "TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 839.98, lowResource: true },
  "TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 795.98, lowResource: true },
  "WizardMath-7B-V1.1-q4f16_1-MLC": { contextWindow: 4096, prefillChunkSize: 4096, slidingWindow: true, vramRequiredMB: 4573.39, lowResource: false },
  "gemma-2-2b-it-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1895.3, lowResource: false },
  "gemma-2-2b-it-q4f16_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1583.3, lowResource: true },
  "gemma-2-2b-it-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2508.75, lowResource: false },
  "gemma-2-2b-it-q4f32_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1884.75, lowResource: true },
  "gemma-2-2b-jpn-it-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 1895.3, lowResource: true },
  "gemma-2-2b-jpn-it-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 4096, slidingWindow: false, vramRequiredMB: 2508.75, lowResource: true },
  "gemma-2-9b-it-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 6422.01, lowResource: false },
  "gemma-2-9b-it-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 8383.33, lowResource: false },
  "gemma-2b-it-q4f16_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 1024, slidingWindow: false, vramRequiredMB: 1476.52, lowResource: false },
  "gemma-2b-it-q4f16_1-MLC-1k": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 1024, slidingWindow: false, vramRequiredMB: 1476.52, lowResource: true },
  "gemma-2b-it-q4f32_1-MLC": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 1024, slidingWindow: false, vramRequiredMB: 1750.66, lowResource: false },
  "gemma-2b-it-q4f32_1-MLC-1k": { contextWindow: 8192, overrideContextWindowSize: 8192, prefillChunkSize: 1024, slidingWindow: false, vramRequiredMB: 1750.66, lowResource: true },
  "phi-1_5-q4f16_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1210.09, lowResource: true },
  "phi-1_5-q4f16_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1210.09, lowResource: true },
  "phi-1_5-q4f32_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1682.09, lowResource: true },
  "phi-1_5-q4f32_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1682.09, lowResource: true },
  "phi-2-q4f16_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 3053.97, lowResource: false },
  "phi-2-q4f16_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2131.97, lowResource: true },
  "phi-2-q4f32_1-MLC": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 4032.48, lowResource: false },
  "phi-2-q4f32_1-MLC-1k": { contextWindow: 2048, overrideContextWindowSize: 2048, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2740.48, lowResource: true },
  "snowflake-arctic-embed-m-q0f32-MLC-b32": { contextWindow: 512, overrideContextWindowSize: 512, prefillChunkSize: 512, slidingWindow: false, vramRequiredMB: 1407.51, lowResource: false },
  "snowflake-arctic-embed-m-q0f32-MLC-b4": { contextWindow: 512, overrideContextWindowSize: 512, prefillChunkSize: 512, slidingWindow: false, vramRequiredMB: 539.4, lowResource: false },
  "snowflake-arctic-embed-s-q0f32-MLC-b32": { contextWindow: 512, overrideContextWindowSize: 512, prefillChunkSize: 512, slidingWindow: false, vramRequiredMB: 1022.82, lowResource: false },
  "snowflake-arctic-embed-s-q0f32-MLC-b4": { contextWindow: 512, overrideContextWindowSize: 512, prefillChunkSize: 512, slidingWindow: false, vramRequiredMB: 238.71, lowResource: false },
  "stablelm-2-zephyr-1_6b-q4f16_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2087.66, lowResource: false },
  "stablelm-2-zephyr-1_6b-q4f16_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1511.66, lowResource: true },
  "stablelm-2-zephyr-1_6b-q4f32_1-MLC": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 2999.33, lowResource: false },
  "stablelm-2-zephyr-1_6b-q4f32_1-MLC-1k": { contextWindow: 4096, overrideContextWindowSize: 4096, prefillChunkSize: 2048, slidingWindow: false, vramRequiredMB: 1847.33, lowResource: true },
};
