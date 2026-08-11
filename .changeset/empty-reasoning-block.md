---
"openbrowse": patch
---

Always request visible reasoning from Anthropic's adaptive models, and stop rendering empty "Reasoning" blocks.

Anthropic's adaptive-thinking generation (Sonnet 4.6, Opus 4.6+) thinks on every turn whether or not you ask it to. The only thing the request controls is whether the thinking comes back: without an explicit `thinking: { type: "adaptive", display: "summarized" }` the provider applies its `display: "omitted"` default and returns thinking blocks whose text is empty. We only asked for `summarized` when the composer's Thinking toggle was on, so with it off the transcript filled up with `Reasoning` / `Thought for Ns` headers that expanded to a blank gutter — for tokens that were spent either way.

- **Thinking is now always on for those models.** `resolveThinkingProviderOptions` is the single entry point both transports use, and it requests thinking when either the user enabled it or `isThinkingAlwaysOn` says the model thinks unconditionally. Putting the rule there rather than at the call sites means the side panel, SW host, headless runs, and the MCP task runner all agree. `isAnthropicAdaptiveThinkingModel` does the version test (>= 4.6) and is family-agnostic, so a new 5.x family is recognised without a code change.
- **The toggle no longer lies.** For an always-on model the switch renders checked and disabled, labelled "Thinking (always on)". The budget slider is hidden there as well — adaptive thinking has no `budget_tokens` knob, so the slider was reporting a number the request never carried.
- **Blank reasoning parts are dropped.** Defence in depth for any provider that returns an empty thinking block: `Reasoning` returns `null` once a blank part has settled, while keeping the header during streaming where it doubles as a liveness cue and the text may simply not have arrived yet.
- **`buildThinkingProviderOptions` takes an optional config.** The always-on path has no user config to pass and shouldn't invent an effort level or budget nobody chose. As a side effect, an enabled toggle with no persisted config now sends vendor defaults instead of silently sending nothing.
