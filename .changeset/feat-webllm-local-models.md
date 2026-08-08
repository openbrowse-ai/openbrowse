---
"openbrowse": minor
---

**Run local WebLLM models as browser agents — and let chat-only models actually be used for chat.** All 139 prebuilt WebLLM models are now surfaced with source-derived metadata, driven from the service-worker agent loop through a new offscreen bridge, and models that can't call tools run a lightweight chat-only path instead of being unselectable dead weight.

Previously the local providers were effectively decorative: the agent loop runs in the service worker, but WebGPU (WebLLM) and `chrome.ai` (Gemini Nano) only exist in the offscreen document, so a local model could never drive a turn. Models were also listed with hand-maintained context windows, and any model without tool calling could be downloaded but never used anywhere.

**Local-model bridge (service worker ↔ offscreen).** A Port-based protocol lets the SW drive a `LanguageModelV3` that physically lives in the offscreen document: `__bridge__/local-model-messages.ts` (wire protocol, with the V3 types derived structurally from the SDK's `LanguageModel` union), `local-model-sw-adapter.ts` (SW-side proxy implementing `doStream`/`doGenerate` over the Port, including mid-stream abort), and `offscreen/lm-stream.ts` (offscreen handler). `createLanguageModel` dispatches on runtime context — SW gets the proxy, offscreen builds the real model, renderer throws.

**Source-derived model catalog.** Every model is generated from a new snapshot (`web-llm-model-context.ts`, 139 entries) instead of hand-maintained values: each model's real context window read from its `mlc-chat-config.json`, plus VRAM, prefill chunk size and sliding-window flag.

- **Context windows are raised to each model's real ceiling.** `context_window_size` is a runtime KV-cache limit, not a compile-time one, so it's overridden per model via `engineConfig.appConfig.model_list[].overrides` (the top-level `appConfig` option is ignored by `@browser-ai/web-llm`). The KV cache is paged and grows on demand, so a large window costs nothing at load time. The 5 sliding-window models are excluded — they're driven by `sliding_window_size` instead.
- `maxOutputTokens` is derived (a quarter of the window, capped at 4096) rather than a flat 1024, so long chat replies aren't truncated.
- Only the 5 models mlc compiles with native function calling carry the `tools` capability; the rest are chat-only until there's per-model evidence, rather than guessing.
- **A browsable catalog** replaces the flat 139-row dump: an always-visible Installed section, families collapsed by default, quantization variants folded behind one row, and capability / context-window / low-resource badges.

**Agent eligibility, and a real chat-only path.** `agentModelGate` encodes what driving the browser agent actually requires: tool calling, plus a context window that can fit one turn (system prompt + tool schemas + page snapshot). It's wired into the agent-only pickers (composer, scheduled tasks), which render ineligible models disabled with a reason.

- Because every OpenBrowse mode (`ask`/`plan`/`act`) is an *approval* mode of a tool-driven agent, a chat-only model had nowhere to go. `composerModelGate` now lets the composer select one anyway, and it runs a new lean chat-only transport: no browser or MCP tools, no page snapshot or per-turn blocks, no completion check, and a short system prompt instead of the full agent prompt — which is the point, since small local models can neither fit nor reliably follow it. Compaction and usage tracking are retained. The Plan/Act switch hides for these models, since there are no tool calls to gate.

**Corrupted-output notice (WebLLM only).** Some WebLLM builds load and report success but emit token salad on specific GPUs/drivers — a known quantization + WebGPU issue, not an extension bug. Without a signal, users see nonsense and blame OpenBrowse.

- A pure, dependency-free detector (`offscreen/coherence.ts`) scores output for that failure mode: writing-system mixing, `U+FFFD` replacement characters, letter/digit fusions, overlong run-together words, and degenerate repetition. Writing systems are counted as *groups* so legitimately multi-script languages (Japanese kanji + kana + Latin) don't read as corruption, and fenced code, inline code, URLs and long hex/base64 blobs are excluded so real agent output isn't misjudged. It's deliberately biased to false negatives — a working model must never be called broken.
- Detection is **passive, not a probe**: replies the model has already produced are scored for free, rather than loading every model to test it. Scoped to `web-llm`; cloud providers have no such failure mode. On a garbled verdict the composer shows a dismissible notice naming the cause and the fix (try a different quantization — a q4f32 build often works where q4f16 fails). Output is never swallowed.
- The catalog carries a matching note up front, so the failure mode is discoverable before a 5 GB download.

**Fixes and hardening.**

- **The UI no longer freezes right after sending to a local model.** Agent turns and chat-title generation were building two engines for the same model and contending on the GPU; all on-device generation now serializes behind a dependency-free FIFO engine lock, and title generation reuses the shared engine.
- **A cold local load is visible instead of looking hung.** WASM instantiate + WebGPU shader compilation can take seconds with zero token output, so load progress is broadcast (throttled to whole percents) and surfaced in the composer as "Loading model… N%".
- Model downloads are serialized and de-duplicated, and downloaded models are reconciled into saved settings so downloading no longer dirties the unsaved-changes bar.
- Models whose declared output modality has no text (e.g. image/video models routed through the AI Gateway) are excluded from the models.dev registry import.
- **Chat-title generation never resolved a compound `provider:model` id**, comparing the whole key against a bare model id — so titles were silently skipped for normally-selected models. Now normalized like the landing-page path.

**Test surface.** +71 tests: the bridge adapter and offscreen handler (including mid-stream abort and error coercion), the download queue, the engine lock (FIFO ordering, rejection propagation, and no queue wedge after a failure), the catalog grouping helpers, the agent/composer/chat-only gates, and the coherence detector — scored against real captured q4f16 garbage plus healthy English, Japanese, Russian, Hindi, code, URL- and hash-heavy replies. All 2,686 tests pass; `tsc --noEmit` clean.
