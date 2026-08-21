# openbrowse

## 0.16.1

### Patch Changes

- a1d2523: Stop a subagent's transcript from leaking into the parent agent's context, and fix subagent token/cost accounting.

  `delegate` returned the subagent's full `transcript` — every assistant message with the complete input and output of every tool it called (DOM snapshots, page text, base64 screenshots) — as part of its tool output. The AI SDK puts a tool's return value straight into the model's prompt unless the tool declares a `toModelOutput`, and only `screenshot` had one, so a single `explore`/`general` delegation (up to 100 steps) could push hundreds of thousands of tokens into the parent's context and keep re-sending them for the rest of the turn. No compaction pass could recover it: pruning runs once per turn at send time, never inside the SDK's tool loop, and the screenshot pruners key on the top-level `part.toolName`, so images nested in another tool's output are invisible to them — the same hazard that keeps `screenshot` out of the batchable registry. `toSDKTool` now projects UI-only fields out of the model-facing view; the persisted part keeps the full output, so the inline trace renders unchanged.

  Subagent tokens were also recorded nowhere — both the standard and CUA loops only counted steps — so a delegation's spend landed in no conversation's `costUsd` and child Context cards stayed empty. Both loops now attribute usage to the child conversation (CUA against the model that actually ran, which is often not the parent's), and a conversation's cost is its own row plus its children, summed at read time so repeated heal-path finalizes can't double-count.

  Finally, the context indicator showed `inputTokens + outputTokens` against an input-only ceiling — the reason it had to clamp at 100%. Display now uses input tokens ("Context Used"), and the compaction trigger keeps the input+output projection under an explicit name, since that's the right number for deciding whether the _next_ request fits.

## 0.16.0

### Minor Changes

- 4b2ead9: **New `askUser` tool: the agent can ask you a multiple-choice question and wait for the answer.**

  When a decision is genuinely yours and guessing wrong is expensive or irreversible — which of three flights to book, which saved card to pay with, which account to post from — the agent now asks instead of picking. The question replaces the chat composer (the slot the plan-approval card uses), so answering is the only thing in front of you.

  - **The bar is deliberately high, because the default is still autonomy.** The system prompt tells the agent to pick a reasonable interpretation and keep going, and this doesn't relax that: the description rules out permission questions ("should I continue?"), anything it could read off the page, and anything with a sensible default. Everything it's blocked on goes in ONE call — 1-4 questions, 2-4 options each, since a second call is a second interruption.
  - **Asking costs the agent its turn, by design.** Registered without an `execute`, which makes it a client-side tool: the agent loop stops on a call it can't resolve, so the run terminates cleanly and the pending question lives in the persisted message list rather than a promise held open in the service worker. A question survives a reload, a side-panel close and an MV3 restart, needs no keepalive, and has **no answer deadline** — nothing is held open while it waits, so it can be answered the next day. Answering writes the tool result and starts a fresh turn.
  - **One question at a time.** Four questions with four described options each is far taller than the composer slot, and stacking them pushed the submit button below the fold. The card paginates — `Question N of M`, clickable progress pips, back/forward arrows — capped just short of the panel viewport with only the question body scrolling, so the action row is always reachable. `←` / `→` navigate from anywhere except the multiline free-text box, where they move the caret (`Alt`/`Cmd` + arrow works there too); `1`-`9` pick options, Enter runs the primary button, `Shift`+`Enter` is a newline.
  - **The buttons say what they do.** The primary reads "Next question" until the last question and then "Submit answers", and stays disabled until the question on screen is answered — otherwise it walked straight past an untouched question. The secondary reads "Skip all questions", not the ambiguous "Decide for me": it always resolves the whole call and discards answers already given, which the old label left to guesswork. Sending a partly-filled set is a separate intent, and stays available from the primary button. On a single-select question the free-text box _replaces_ a picked option rather than adding to it, so the output can't carry a choice and contradicting text at once.
  - **Answers come back structured.** `{ outcome: "answered" | "dismissed", answers: [{ question, header, selected, other? }] }` — selections as an array rather than a comma-joined string, which is lossy for any label containing a comma and has to survive serialize → chatDb → compaction; and skipped questions omitted rather than returned with an empty `selected`, which would read to the model as "replied and said nothing".
  - **Unavailable wherever there is no human.** Dropped from every headless run — scheduled tasks and MCP `task` — unconditionally rather than only when auto-approval is off, since `autoApprove` grants consent but cannot supply an answer. Also blocked for subagents, ahead of the `allowedTools` filter.

  **Three layers had to learn that "waiting on the user" isn't "stranded".** A pending `askUser` rests in `input-available`, which everywhere else in the codebase is a reliable orphan signal, so each of these terminalized the question before it could be answered — the user saw a struck-through "You answered / Interrupted" row for a question they were never shown. Same shape of bug the `PlanApprovalCard` regression once had, and all three now key on the tool name rather than the state: `healSerializedParts` (rewrote the part to `output-error` on every run termination; now carved out beside `approval-requested`), `resolveToolPartState` (rendered it errored the moment streaming stopped, which is immediate since asking ends the turn), and the queue auto-flush watcher (would have drained a queued message over the open question and healed it away).

  **Test surface.** 106 new tests across five suites: the pending-question finder (both AI-SDK part shapes, and the load-bearing "must be the last message" rule that `addToolOutput`'s `messages.at(-1)` scan imposes), the resume predicate (with regression guards for both `sendAutomaticallyWhen` helpers the SDK ships, neither of which is safe here), the tool schema, the card's keyboard resolver (extracted because its correctness turns entirely on where focus is), and the card's draft/output helpers. Plus carve-out tests for all three layers above and their inverses. All 2,956 tests pass; `tsc --noEmit` clean and `wxt build` succeeds.

### Patch Changes

- f04f48a: Always request visible reasoning from Anthropic's adaptive models, and stop rendering empty "Reasoning" blocks.

  Anthropic's adaptive-thinking generation (Sonnet 4.6, Opus 4.6+) thinks on every turn whether or not you ask it to. The only thing the request controls is whether the thinking comes back: without an explicit `thinking: { type: "adaptive", display: "summarized" }` the provider applies its `display: "omitted"` default and returns thinking blocks whose text is empty. We only asked for `summarized` when the composer's Thinking toggle was on, so with it off the transcript filled up with `Reasoning` / `Thought for Ns` headers that expanded to a blank gutter — for tokens that were spent either way.

  - **Thinking is now always on for those models.** `resolveThinkingProviderOptions` is the single entry point both transports use, and it requests thinking when either the user enabled it or `isThinkingAlwaysOn` says the model thinks unconditionally. Putting the rule there rather than at the call sites means the side panel, SW host, headless runs, and the MCP task runner all agree. `isAnthropicAdaptiveThinkingModel` follows the documented scope: on the 4.x line only Sonnet 4.6 and Opus 4.6+ qualify, and family-agnostic detection begins at 5.x, so a new 5.x family is recognised without a code change.
  - **The toggle no longer lies.** For an always-on model the switch renders checked and disabled, labelled "Thinking (always on)". The budget slider is hidden there as well — adaptive thinking has no `budget_tokens` knob, so the slider was reporting a number the request never carried.
  - **Blank reasoning parts are dropped.** Defence in depth for any provider that returns an empty thinking block: `Reasoning` returns `null` once a blank part has settled, while keeping the header during streaming where it doubles as a liveness cue and the text may simply not have arrived yet.
  - **`buildThinkingProviderOptions` takes an optional config.** The always-on path has no user config to pass and shouldn't invent an effort level or budget nobody chose. As a side effect, an enabled toggle with no persisted config now sends vendor defaults instead of silently sending nothing.

- 3e27887: **Batched tool calls now read like direct ones.** Expanding a `batch` row showed each invocation as its raw tool name plus a generic `key: value` argument dump — `webSearch  query: Kindle API read book content third party app…` — while the same call made on its own read `Searched “Kindle API read book content…” — 8 results`. Four batched searches gave no indication of whether any of them returned anything.

  The cause was that label resolution wasn't reusable: it lived as an inline ternary chain inside the `ToolCallBlock` component body, so `tool-results/batch.tsx` had no way to ask what a tool's row would say and fell back to summarizing arguments. It's now an exported `resolveToolLabels(toolName, args, result)`, injected into `BatchResult` the same way `renderChild` already is — the label table lives in `ToolCallBlock`, and importing it from `tool-results/batch` would form a cycle.

  - Child rows use the tool's own label, so a batched `webSearch` carries its query **and result count**, a batched `Grep` reads "Searched" rather than `Grep`, and a failed search reads "Search failed: …" instead of looking indistinguishable from a successful one.
  - Rows for a batch whose input is still streaming use the same labels in their `pending` form.
  - Tools with no specific label keep the existing argument summary rather than degrading to the bare tool name: `resolveToolLabels` returns `undefined` in that case and each caller picks its own fallback.
  - No behaviour change for top-level rows. The denied paths still read `deniedReplace`/`denied` from the tool's static entry, which the per-tool helpers don't customize.

  +9 tests on the extracted resolver, covering the reported `webSearch` case, static-only tools, result-derived labels, the `undefined` signal, and malformed arguments.

## 0.15.0

### Minor Changes

- ee5d3cc: **Memory v2: file-first, folder-based, agent-authored memory (markdown brain + `[[wikilink]]` graph + keyword search).**

  Agent memory moves from an opaque IndexedDB store with exact-title-only recall to a file-first knowledge graph inspired by Garry Tan's `gbrain`, adapted for the extension. The agent now reads, writes, and organizes memory as plain markdown files in a folder tree using the normal file tools — writing a memory is just writing a file. IndexedDB becomes a rebuildable search index, and retrieval is a real hybrid keyword + backlink-boosted search. This is Tier 0 of the design — keyword + graph retrieval that works for everyone with zero new downloads. (Local/cloud embeddings and background consolidation are follow-ups.)

  What changed:

  - **Files are the source of truth; the agent authors them directly.** Memory is a folder tree in OPFS — `memory/**` (global) or `spaces/<spaceId>/memory/**` (space-scoped) — that the agent maintains with the existing `Read`/`Write`/`Edit`/`Move`/`LS`/`Glob`/`Grep` tools. Organization is emergent, not prescribed: no required folders, no fixed taxonomy. Recommended page shape is YAML frontmatter + a `# Compiled truth` + `# Timeline` body, but plain markdown works too.
  - **The four bespoke memory tools are gone.** `saveMemory`, `updateMemory`, `recallMemory`, and `deleteMemory` are removed. Recall is `Read`/`searchMemory`; save/update is `Write`/`Edit`; forget is `Delete`.
  - **Ungated except Delete.** Writing, editing, and moving memory files run without prompting (ambient capture + reorganize). Deleting a memory is the only gated memory action. A new `Move` fs op (ungated) reorganizes/renames and reindexes both paths; it refuses to cross the memory boundary in either direction, so a move can't become an ungated delete (or smuggle an unreviewed workspace file into memory).
  - **Self-wiring `[[wikilink]]` graph (bare basename).** Links are bare basenames (`[[garry-tan]]` resolves to any `…/garry-tan.md` in scope), so they survive moving a file between folders. Reindex-on-write parses links and maintains a link/backlink table — no LLM calls. Linked-to notes rank higher in search.
  - **New `searchMemory` tool.** Free-text search over title/aliases/description/body, weighted by field, boosted by backlinks, returned with snippets, file paths, and a 1-hop "related via links" set.
  - **Derived index kept fresh by reindex-on-write + startup reconcile.** A v2 IndexedDB schema (`memoryIndex` keyed by file path + `links`) caches parsed frontmatter, a searchable body copy, and link edges. Every fs mutation under a memory root reindexes that path; a startup `reconcile()` re-derives the whole index from disk, self-healing drift and picking up hand edits.
  - **One-time v1 → v2 migration.** At service-worker startup, legacy IndexedDB memory rows are rewritten as flat v2 files (no imposed foldering; the `type` field is dropped) and the index is reconciled from disk. Idempotent and guarded by a `memorySchemaVersion` flag; the legacy `memories` store is kept read-only for one release as a safety net.
  - **Prompt + UI updates.** `MEMORY_INSTRUCTIONS` teaches the file-first workflow (search/read before write, write files directly, bare `[[name]]` links, compiled-truth/timeline convention, emergent organization) with no prescribed taxonomy; the injected index is a compact, path-indexed listing grouped by scope then folder and capped (with overflow deferred to `searchMemory`). Settings and per-space memory management now render a file tree + markdown viewer with a search box, replacing the flat list.
  - **Memory viewer.** Settings › Memory is a secondary-sidebar master/detail (matching Skills/Connectors): a folder tree on the left, the note on the right. The viewer strips YAML frontmatter from the preview and surfaces it as a parsed header (title, description, aliases, updated) the way the Skills tab shows a skill's description, offers a **Rendered ⟷ Source** toggle, and renders `[[wikilinks]]` as clickable links that navigate between notes. Delete lives in the viewer's action row behind a confirmation. In a space, memory files open in the shared rail viewer just like Space files.
  - **Clickable provenance.** Timeline entries can now cite a source the user can actually click. `[Source: [[chat:<conversationId>]]]` renders as a link back to the conversation the fact came from (label defaults to `chat`, so existing `[Source: chat]` entries look unchanged — just live); the prompt injects the current conversation id so the agent can write it. `[Source: example.com/path]` now linkifies too — GFM only autolinks scheme-ful URLs, so scheme-less citations previously rendered as dead text. Both are pre-processed into fragment hrefs (`#chat-`, `#wl-`) that the renderer hands back as real anchors, which the viewer intercepts. Clicking a chat link verifies the conversation still exists (memory outlives conversations) and either switches conversations in place or focuses/opens a home tab, depending on the surface. `[[chat:…]]` is excluded from `parseLinks`, so provenance never pollutes the memory graph with dangling nodes.
  - **Memory graph.** A graph icon next to "Memory" opens an Obsidian-style force-directed view of the `[[wikilink]]` graph — pan, cursor-anchored zoom, drag nodes with release momentum, hover tooltips, node size by backlink count, colour by scope, and hollow "dangling" nodes for links whose note doesn't exist yet (a useful gap signal). Click a node to open that note. The graph is the default detail view when no note is selected. Implemented with a small dependency-free force simulation rendered as SVG — no graph library added to the bundle.
  - **The open note is URL-backed.** Settings › Memory encodes the note you're viewing as `?tab=memory&note=<path>` via `pushState`, so a reload restores it and Back closes the note (returning to the graph) instead of leaving the page. The path is never trusted on read: the browser validates it against the currently visible file set and falls back to the graph if the note was deleted, renamed, or belongs to another space. Leaving the Memory tab drops the param structurally, in the search-string formatter, rather than relying on each caller to remember.

  **Test surface.** Unit tests for the format module (slugify, bare-basename wikilink parsing, `parseMemoryPath`, serialize/parse round-trip, scoring, hashing), the file-first store (`syncPath`/`reconcile`/`search`/`deleteById`/`removeUnder`, keyword ranking, backlink boost, related-via-links, move-safe basename links, scope visibility, link resolution, graph building incl. basename fan-out/dangling/self-link/scope), the fs memory mount (write/read/move/delete gating + reindex, cross-space denial), the v1→v2 migration (flat files, slug-collision handling, idempotency, scope mapping), and the settings route module (note parse/format, note scoped to the Memory tab, other params preserved). Plus unit tests for the memory markdown linkifier (note links, `[[chat:…]]` provenance links, bare-domain and scheme-ful source citations, filename-vs-domain disambiguation) and a contract test asserting the emitted hrefs survive the markdown renderer's URL sanitization. All 2,681 tests pass; `tsc --noEmit` clean.

- 7c0edfc: **Run local WebLLM models as browser agents — and let chat-only models actually be used for chat.** All 139 prebuilt WebLLM models are now surfaced with source-derived metadata, driven from the service-worker agent loop through a new offscreen bridge, and models that can't call tools run a lightweight chat-only path instead of being unselectable dead weight.

  Previously the local providers were effectively decorative: the agent loop runs in the service worker, but WebGPU (WebLLM) and `chrome.ai` (Gemini Nano) only exist in the offscreen document, so a local model could never drive a turn. Models were also listed with hand-maintained context windows, and any model without tool calling could be downloaded but never used anywhere.

  **Local-model bridge (service worker ↔ offscreen).** A Port-based protocol lets the SW drive a `LanguageModelV3` that physically lives in the offscreen document: `__bridge__/local-model-messages.ts` (wire protocol, with the V3 types derived structurally from the SDK's `LanguageModel` union), `local-model-sw-adapter.ts` (SW-side proxy implementing `doStream`/`doGenerate` over the Port, including mid-stream abort), and `offscreen/lm-stream.ts` (offscreen handler). `createLanguageModel` dispatches on runtime context — SW gets the proxy, offscreen builds the real model, renderer throws.

  **Source-derived model catalog.** Every model is generated from a new snapshot (`web-llm-model-context.ts`, 139 entries) instead of hand-maintained values: each model's real context window read from its `mlc-chat-config.json`, plus VRAM, prefill chunk size and sliding-window flag.

  - **Context windows are raised to each model's real ceiling.** `context_window_size` is a runtime KV-cache limit, not a compile-time one, so it's overridden per model via `engineConfig.appConfig.model_list[].overrides` (the top-level `appConfig` option is ignored by `@browser-ai/web-llm`). The KV cache is paged and grows on demand, so a large window costs nothing at load time. The 5 sliding-window models are excluded — they're driven by `sliding_window_size` instead.
  - `maxOutputTokens` is derived (a quarter of the window, capped at 4096) rather than a flat 1024, so long chat replies aren't truncated.
  - Only the 5 models mlc compiles with native function calling carry the `tools` capability; the rest are chat-only until there's per-model evidence, rather than guessing.
  - **A browsable catalog** replaces the flat 139-row dump: an always-visible Installed section, families collapsed by default, quantization variants folded behind one row, and capability / context-window / low-resource badges.

  **Agent eligibility, and a real chat-only path.** `agentModelGate` encodes what driving the browser agent actually requires: tool calling, plus a context window that can fit one turn (system prompt + tool schemas + page snapshot). It's wired into the agent-only pickers (composer, scheduled tasks), which render ineligible models disabled with a reason.

  - Because every OpenBrowse mode (`ask`/`plan`/`act`) is an _approval_ mode of a tool-driven agent, a chat-only model had nowhere to go. `composerModelGate` now lets the composer select one anyway, and it runs a new lean chat-only transport: no browser or MCP tools, no page snapshot or per-turn blocks, no completion check, and a short system prompt instead of the full agent prompt — which is the point, since small local models can neither fit nor reliably follow it. Compaction and usage tracking are retained. The Plan/Act switch hides for these models, since there are no tool calls to gate.

  **Corrupted-output notice (WebLLM only).** Some WebLLM builds load and report success but emit token salad on specific GPUs/drivers — a known quantization + WebGPU issue, not an extension bug. Without a signal, users see nonsense and blame OpenBrowse.

  - A pure, dependency-free detector (`offscreen/coherence.ts`) scores output for that failure mode: writing-system mixing, `U+FFFD` replacement characters, letter/digit fusions, overlong run-together words, and degenerate repetition. Writing systems are counted as _groups_ so legitimately multi-script languages (Japanese kanji + kana + Latin) don't read as corruption, and fenced code, inline code, URLs and long hex/base64 blobs are excluded so real agent output isn't misjudged. It's deliberately biased to false negatives — a working model must never be called broken.
  - Detection is **passive, not a probe**: replies the model has already produced are scored for free, rather than loading every model to test it. Scoped to `web-llm`; cloud providers have no such failure mode. On a garbled verdict the composer shows a dismissible notice naming the cause and the fix (try a different quantization — a q4f32 build often works where q4f16 fails). Output is never swallowed.
  - The catalog carries a matching note up front, so the failure mode is discoverable before a 5 GB download.

  **Fixes and hardening.**

  - **The UI no longer freezes right after sending to a local model.** Agent turns and chat-title generation were building two engines for the same model and contending on the GPU; all on-device generation now serializes behind a dependency-free FIFO engine lock, and title generation reuses the shared engine.
  - **A cold local load is visible instead of looking hung.** WASM instantiate + WebGPU shader compilation can take seconds with zero token output, so load progress is broadcast (throttled to whole percents) and surfaced in the composer as "Loading model… N%".
  - Model downloads are serialized and de-duplicated, and downloaded models are reconciled into saved settings so downloading no longer dirties the unsaved-changes bar.
  - Models whose declared output modality has no text (e.g. image/video models routed through the AI Gateway) are excluded from the models.dev registry import.
  - **Chat-title generation never resolved a compound `provider:model` id**, comparing the whole key against a bare model id — so titles were silently skipped for normally-selected models. Now normalized like the landing-page path.

  **Test surface.** +71 tests: the bridge adapter and offscreen handler (including mid-stream abort and error coercion), the download queue, the engine lock (FIFO ordering, rejection propagation, and no queue wedge after a failure), the catalog grouping helpers, the agent/composer/chat-only gates, and the coherence detector — scored against real captured q4f16 garbage plus healthy English, Japanese, Russian, Hindi, code, URL- and hash-heavy replies. All 2,686 tests pass; `tsc --noEmit` clean.

### Patch Changes

- 07efcd3: **New `batch` tool: run several independent reads in one call.** The agent can now fan out up to 8 read-only tool calls concurrently — `snapshot`, `readPage`, `extract`, `webSearch`, `searchMemory`, `skill`, workspace `Read`/`Glob`/`Grep`/`LS`, `listTabs`, `read_network_requests`, `read_console_messages`, `list_artifacts`, `read_artifact_diagnostics` — instead of spending a round-trip on each. Reading three tabs, grepping two patterns, or firing four search queries is now one step rather than four.

  Note that the AI SDK already runs multiple tool-call parts from a single step concurrently, so the win here is not raw parallelism: it's collapsing N tool calls into one for models that won't reliably emit parallel calls, and cutting the output tokens spent restating shared arguments.

  - **Read-only by construction, not by convention.** Every safety decision in the extension lives in the tool-call wrapper — approval-mode dispatch (ask/plan/act), the per-site "Always allow on this site" allowlist, `executeOnPage`'s static read check, `executePython`'s network gate — and a batch invokes tools beneath that wrapper. Rather than duplicate or relax that gating, the batchable registry only admits tools that need none of it. Clicking, typing, navigating, writing, moving, deleting, and code execution are not batchable and still take their normal approval path; batching one returns an error for that invocation and leaves the others alone. Guard tests fail the build if a batchable tool ever becomes approval-gated, mutating, or lands on the headless drop list.
  - **`screenshot` is deliberately excluded.** Compaction identifies strippable images by tool name, so a screenshot nested inside a batch would never be pruned and would grow context without bound.
  - **Subagents get a narrowed batch.** `batch` is rebuilt per subagent over the intersection of its `allowedTools` and the registry, so batching can never reach a tool the agent definition withheld. Enabled for `explore` and `general`.
  - **Partial failure is contained.** One failing invocation no longer sinks the rest: results return in request order, each as `{ name, ok, output?, error? }`. Tools that report failure in their payload rather than by throwing — `webSearch` returns `{ results: [], error }` — are counted as failed while keeping their output, so the tally reflects what actually came back instead of showing a green check above red error text.
  - **The call reads as the work, not the mechanism.** The agent supplies a required `description` naming the job in the user's terms ("Comparing pricing pages") and the interface owns progress and outcome: `4 reads` while running, `4 of 4` when every read lands, an amber `3 of 4` when one doesn't. The phrase is kept verbatim rather than re-tensed on completion — conjugating arbitrary model text is brittle in English and wrong in other languages — and the leading glyph carries the state instead. Expanding a call lists each invocation, and opening one renders that tool's own normal result card.
  - **A batch runs as one wave.** All 8 invocations go out together — a batch exists to spend one round-trip, so re-serializing the work behind a limiter would give back most of what it buys. The concurrency limiter stays in place as the honest spot for a ceiling should rate limiting show up in practice, in which case the fix is backing off the failing call rather than slowing every batch.

  **Test surface.** 58 tests across three new suites: batch execution (ordering, per-invocation isolation, schema violations against the child tool's own schema, non-batchable and prototype-property names, JSON-string arguments, concurrency ceiling, sub-scoped tool-call ids, cancellation mid-flight, in-band error detection), the collapsed-row labels (running/complete/partial/whole-tool-failure, count suppression when the fallback label already carries it, missing-description fallback), and the argument summary. Plus registry invariants (approval-free, no mutating tools, nothing headless drops, keys match tool names) and 5 tests covering `scanToolUsage` seeing through a batch so a batched `skill` load or space-file `Read` still registers. All 2,844 tests pass; `tsc --noEmit` clean across the workspace.

- 2508709: **Stop runaway automatic context compaction on large-context models.** A conversation that crossed the compaction threshold once could keep auto-compacting every ~30 seconds indefinitely — visibly re-summarizing and re-injecting a "Continue where you left off" turn on a chat that wasn't long enough to warrant it, most noticeably on 1M-token models.

  Three independent defects compounded into the loop:

  - **Repeat compactions summarized the wrong history.** `runCompaction` built its prunable view from the renderer's `messages` — the full UI transcript, which deliberately retains every pre-compaction message so the user can still scroll back. So the second pass re-selected the _original_ head that the first pass had already summarized, produced a near-identical summary, and left context occupancy unchanged. Auto-compaction now runs `filterCompactedMessages` first, so each pass starts from the same compacted history the model actually sees; manual `/compact` stays a whole-history operation by design.

  - **Loop protection was purely time-based.** `shouldDebounceCompaction` only suppressed a re-run within `COMPACTION_DEBOUNCE_MS` (30s), so once persisted usage sat above the threshold, the cycle resumed on the next completed turn — forever. Added a progress invariant (`hasCompactionHeadProgress`): if the newly selected head contains nothing but the previous compaction marker and its summary, summarizing it again cannot shrink context, so the attempt is skipped. Unlike the debounce this blocks unchanged re-entry permanently, while still allowing compaction once genuinely new head content accumulates.

  - **The threshold could be computed from bad limits.** `getUsableTokens` returns `contextWindow - maxOutputTokens - 20_000`, and usage snapshots persist `contextWindow: 0` when the service worker can't resolve model metadata — yielding a _negative_ ceiling that makes every finished turn eligible for compaction. Both non-positive limits and mutually incompatible positive ones (`maxOutputTokens` + buffer >= `contextWindow`, which real small-window models like Gemini Nano and the smallest WebLLM builds declare) now fall back to the default ceiling, so proactive compaction simply stays off for models with no headroom to summarize into; a genuine overflow is still recovered by the overflow-triggered path. The "context too small" agent-eligibility gate keeps its old meaning via a dedicated `hasCompactableContext` predicate. Relatedly, the post-turn check paired the SW-persisted `contextWindow` with `maxOutputTokens` read from the renderer's `getCurrentModelDef()`, which the agent loop no longer mutates under SW-host; `ConversationUsage` now records the output ceiling of the model the SW actually used, with the renderer value kept only as a fallback for pre-existing conversations.

  `findCompactionEvents` also no longer requires a truthy `summary` flag on the summary assistant message, only that it isn't explicitly `false`. Persisted rows carry `summary: true`, but in-memory AI SDK UI messages have no such field — matching how `compacting-transport.ts` already detects compaction events structurally — so the same detection now works on both shapes. This is what lets the renderer reuse `filterCompactedMessages` against its live message list.

  **Test surface.** +4 tests in `compaction.test.ts`: the compacted-view head selection and summary-only re-entry rejection (modeled on a 1M-context / 128K-output model through a full compaction + synthetic-continue cycle), the head-progress invariant releasing once new content lands, and threshold math for both real 1M limits and the unresolved-zero snapshot. All 2,690 tests pass; `tsc --noEmit` clean.

- ee5d3cc: **Fix stale file/memory views when another extension context writes to OPFS.**

  `emitVfsChange` only reached listeners inside the JS context that performed the write. Since agent runs execute in the MV3 service worker while the UI lives in extension pages, a Settings > Memory tab (or any open file viewer) kept rendering whatever it read on mount — the agent could author `memory/**` mid-run and the tab would still show the old tree and old file contents until reload.

  - `vfsEvents` is now bridged across same-origin extension contexts over a `BroadcastChannel`, so a write from the service worker, the sidepanel, or another tab re-emits `vfs:change` everywhere. Subscribers are unchanged — they still just listen on `vfsEvents`.
  - The memory browser, the memory frontmatter header, and the file viewer additionally re-read on `visibilitychange`, a catch-up for a background tab that was frozen or throttled when the broadcast went out.
  - A memory write now emits a second `vfs:change` after `syncPath` lands the index row. The `OPFS.*` emit fires _before_ reindexing, so a surface rendering parsed frontmatter would otherwise read the previous row; subscribers debounce, so the two emits coalesce into one refresh.
  - A same-file text reload in `FileViewerPanel` now swaps content in place instead of blanking the pane first, so a live-updating file no longer flashes on every write.

- 5ebad56: Make a long agent run readable: separate the agent's progress notes from its final answer, and present a delegated subagent as a layer below the conversation.

  - **Progress notes vs. final answer.** Every text part used to be a hard break in the transcript (`buildSegments`), which had two effects: the agent's between-call commentary ("Let me check the pricing page.") was preserved forever as body prose at the same visual weight as the actual answer, and it chopped runs of tool calls too finely to ever reach the "Completed N steps" fold threshold. The result alternated preamble, fold, preamble, fold. `findNarrationIndices` now classifies each text part as narration or answer; narration renders small and muted in place, above the calls it introduced, and folds away with them into the step group.
  - **Guards so a real answer is never folded.** Text over 400 characters stays at full weight even when tool calls follow it, and once the stream ends the last non-empty text part is always the answer — so a terse "Done — updated 3 rows." followed by `closeTabs` cleanup stays visible.
  - **Lower fold threshold.** Because narration no longer splits runs, a group folds at 2 tool calls instead of 3.
  - **Prompt guidance.** A new `## Narrating your work` section tells the model about the two channels: one short progress note per batch of calls, no restating tool results or re-explaining the plan, and never leave the answer in a progress note alone, since those get folded away.
  - **Subagent runs read as a nested layer.** A `delegate` trace block — header and body together — now sits behind a `ㄴ` branch marker, so a delegation looks like one indented step in the parent transcript rather than a continuation of the parent's own work. The marker is decorative and unselectable, so copying a transcript doesn't pick it up.
  - **Subagent traces start collapsed.** The block opened expanded, so a subagent that ran 30 tool calls dumped all 30 into the parent conversation — burying the work the user delegated away precisely so they wouldn't have to read it. The header row already carries the live status (shimmering title while running, step count, failure dot), so the run stays legible at a glance and expands on click.

## 0.14.0

### Minor Changes

- 46c9db6: **Mention past chats in the composer.** Type `@` in the chat composer to reference open tabs _and_ previous conversations from one unified popup. Selecting a chat inserts a chat chip, and on send the referenced conversation's transcript is injected as context for the model — so you can pick up a thread, cross-reference an earlier decision, or ask the agent to build on prior work without re-pasting anything.

  `@` now surfaces two labelled groups (Tabs and Past chats) over a single keyboard cursor, mirroring how `/` lists commands and skills:

  - The unified `@` suggestion queries open tabs and `chatDb.listRootConversations()` (recent-first, fuzzy-filtered by title, subagent child runs excluded) and inserts the right node per selection: tabs become `tabMention` nodes (`@[title](url)`), chats become `chatMention` nodes (`#[title](chat:id)`). Distinct node types and markdown tokens keep the two paths unambiguous, so existing tab behaviour is untouched.
  - Chat chips render as `@Title` in the composer and in sent-message history (via a read-only node variant), styled with a `.chat-mention` chip class across the side panel and home surfaces.

  **Context injection (both tabs and chats) is now carried as a message part, not inline text.** The resolved context — mentioned tabs' page content and mentioned chats' transcripts — is captured at send time (preserving the tab/chat snapshot the user saw) and attached to the user message as a persisted, UI-invisible `data-mention-context` part. The transport substitutes it into a text part immediately before the model request (`rewriteForLLM` → `substituteMentionContextPart`), so:

  - the composer bubble renders only the user's text + chips, with **no display-side stripping** (removing a class of "context leaked into the bubble" bugs);
  - the model's view stays **consistent across reloads** (the part round-trips through chat-db); and
  - there's a **single injection point** in the transport rather than context smuggled through the text and re-hidden in every render/edit surface.

  Transcripts skip system rows and auto-compaction summaries and de-duplicate by conversation id; the part's text is counted by `estimateMessageTokens` so compaction triggers accurately. Wired into all send paths: initial send, queue-while-streaming, message edit, and the landing/hero composer.

  **Long chats are summarized, not truncated.** When a mentioned chat's transcript exceeds a token threshold, it's condensed with a compaction-style summary (via the user's configured compaction model) instead of pasting an arbitrary head slice. Summaries are generated once and cached for the session (keyed by message count + last message id, so a chat that grows re-summarizes); if summarization is unavailable the block falls back to a truncated transcript. The reusable summarizer (`summarizeMessages`) is factored out of the live compaction flow.

  **Shimmer feedback while summarizing.** A long-chat summary resolves at send time, so every send path gives feedback with the mention chip shimmering (a `.chat-mention-resolving` CSS sweep) until the context is ready and the turn dispatches — the send/transport path itself is untouched:

  - **Side panel** (in-conversation sends and message edits): an optimistic `PendingMentionBubble` echoes the message while `handleSubmit`/`confirmEdit` resolves the context, then the real turn dispatches.
  - **Queue-while-streaming**: enqueuing a message that references a chat clears the composer immediately and shows an optimistic, pulsing placeholder row in the queue while the snapshot resolves, then the real queued item replaces it.
  - **Home landing hero** (new-chat sends): the send navigates to the chat view _immediately_ (persisting clean text), and mention resolution is deferred to the first-turn dispatch — so the real message renders right away and its chip shimmers in place while its referenced chats are summarized, then the turn dispatches. No frozen hero, no message-bubble-on-hero hybrid.

  **Test surface.** +16 tests: chat-mention token parsing, verbatim transcript formatting (injection, system/summary filtering, empty placeholder), long-chat summarization routing (threshold, cache hit, cache invalidation, fallback), and the transport contract (data part → model text substitution, untouched-when-absent, serialize/deserialize round-trip).

- 4694029: **Universal palette search: the ⌥K palette now searches tabs, chats, artifacts, spaces, and commands from one input, with grouped results and scoping.**

  The command palette was previously "Search tabs" — a single URL-centric list (open tabs, favorites, bookmarks, history, recently-closed) plus a separate `/`-gated action mode. It now fans a single query out across every kind of thing you've touched, keeps results grouped and scannable, and folds commands in as a first-class group instead of a mode.

  What changed:

  - **Five result groups from one query.** The tuned URL pipeline is untouched and becomes the "Open & visited" group; new isolated builders add **Chats**, **Artifacts**, **Spaces**, and **Commands**. Groups render in a fixed order (URL results always first), each capped (8/4/4/3/4) with "show more", and empty groups are omitted. Chat/artifact/space matching is metadata-only (title/description/name), scored with the existing `scoreQuery`, so the palette stays synchronous and instant.
  - **Dual scoping.** Type a leading token (`chat:`, `art:`/`artifact:`, `space:`, or `/` for commands) or click/`Tab` a group header to narrow to one group; a removable "Filtering" chip reflects the active scope and `Esc`/`Backspace` clears it. `/` is now simply the command scope — the separate action mode is gone, and its now-dead `OverlayActionList`/`SortableSpaceItem` components were removed (the action data + `useFilteredActions` moved to `components/actions.ts`).
  - **Commands are first-class.** They surface from any plain query (type "settings" and the command appears) and the full command set shows in the empty-query zero state. The zero state is now Favorites → Recents (recent chats + recent artifacts) → Commands; recently-closed tabs no longer clutter the default view (they still appear when you search).
  - **New actions.** Enter opens a chat in a dedicated chat tab (reusing the current tab in extension context), opens an artifact's rendered view in a new tab, or switches to a space. The **"AI chat" command became "New chat"** and opens the chat landing page (new-tab) instead of the side panel; the side panel remains on ⌥I.
  - **Data plumbing.** New background endpoints `OVERLAY_LIST_CHATS` / `OVERLAY_LIST_ARTIFACTS` (chat DB + OPFS live in the extension context, not the content-injected overlay), plus `OVERLAY_OPEN_CHAT` / `OVERLAY_OPEN_ARTIFACT`.

  UI polish and fixes bundled in:

  - **Tab-row drag handle** no longer reserves a column — the grip now appears over the favicon on hover, tightening every row.
  - The Home sidebar button is relabeled **"Search"** (it's no longer tabs-only), and the palette placeholder reads "Search tabs, chats, artifacts… / for commands".
  - **⌥K now works on the new-tab page.** The `open-search` command bailed on `chrome://newtab/` before checking for our own pages; it now routes the NTP (and any of our extension pages) to the in-page overlay toggle.
  - **`TOGGLE_HOME_OVERLAY` is window-scoped.** `HomeApp` and the settings-page `useOverlay` hook ignore toggles aimed at another window (messages without a `windowId` still broadcast), so ⌥K only toggles the focused window's palette instead of every open home/new-tab instance.
  - **`Tidy tabs` / `Clean` work from the palette again.** `execGlobalAction` now passes the overlay's known `windowId` in `OVERLAY_GLOBAL_ACTION`; previously the background couldn't resolve a window from the overlay iframe and these actions silently no-oped.
  - **Enter (⏎) activates any focused result.** The footer's ⏎ button and keyboard Enter now share one path, so it opens the focused chat/artifact/space/command — not just tabs.
  - **`space:` scope lists every space** (ordered by position) on an empty query, matching the other scopes' zero-state behavior.
  - **Opening an artifact reuses its existing tab** when one is already open, instead of stacking duplicates.
  - **Scoped `TOGGLE_HOME_OVERLAY` no longer races startup.** If a window-scoped toggle arrives before a home/new-tab instance has resolved its own window id, it resolves the id first and applies only on a match, so early ⌥K presses never leak to the wrong window.

  **Test surface.** +20 unit tests for the palette foundation (`overlay/search/palette.test.ts`: builders, scope-token parsing, grouping/caps/scope, and the `Match → PaletteResult` adapter). All 2,208 tests pass; `tsc --noEmit` clean.

- 44d7f43: **Add a `webSearch` agent tool backed by a managed, server-side Exa proxy.**

  The agent can now search the web as a fast "find" layer — ranked results with a text excerpt and highlighted snippets — without an API key ever shipping in the (fully inspectable) extension bundle. The key lives only on the server.

  - **Hosted proxy (`apps/docs/app/api/search`).** A `POST /api/search` route forwards the query to Exa using a server-side `EXA_API_KEY`, clamps `numResults`, requests text + highlights, normalizes results to only the fields we expose, and applies best-effort per-IP rate limiting. Requires `EXA_API_KEY` in the docs deployment.
  - **Extension tool (`webSearch`).** Calls the proxy (localhost in `wxt dev`, hosted in production; override with `WXT_PUBLIC_SEARCH_ENDPOINT`), bounded by a 20s timeout and the agent loop's abort signal. Errors are returned to the model, never thrown. For deep reading or pages behind login, the agent still follows up with `navigate` + `readPage`/`extract`.
  - **UI.** Dedicated result renderer plus dynamic status labels (e.g. `Searched "…" — 8 results`).

  Registered in the browser tool set and the tool-input-schema test. +5 tool tests.

### Patch Changes

- c8ed694: **Add an "Add to space" action to the chat thread actions menu.**

  The chat header's ⋯ menu now has an "Add to space" submenu listing your spaces.
  Selecting one moves the conversation into that space; the space it already
  belongs to is disabled, and a "Remove from space" item appears when the
  conversation is currently in a space (moving it back to the global scope). The
  sidebar re-scopes immediately in the same window via a `chat-moved` event, since
  the cross-window `CONVERSATION_UPDATED` broadcast isn't delivered to the sender's
  own context.

- 804b852: **Add an "Open in new tab" action to the Space file viewer.**

  The file viewer's header now offers an "Open in new tab" button (next to Download) when viewing a Space's workspace file. Clicking it pops the file out into a dedicated `file.html` tab that renders the same `FileViewerPanel` full-screen, so large files, PDFs, sheets, HTML previews, and code can be read without the constraints of the side rail.

  - `components/files/FileViewerPanel.tsx` — new optional `openInNewTab` prop. When set, renders an `ExternalLink` icon button that calls `chrome.tabs.create` with `file.html?path=<opfs-path>&name=<file-name>`. Off by default, so conversation-file surfaces are unchanged. Because OPFS is scoped to the extension origin and shared across every extension page, the new tab reads the exact same file by path — no blob handoff across contexts is needed.
  - `entrypoints/file/` — new standalone tab entrypoint (mirrors the artifact tab). `main.tsx` reads `path`/`name` from the query string, applies the app theme via `useTheme`, and mounts `FileViewerPanel` with `onClose={() => window.close()}`. It intentionally omits `openInNewTab` so the standalone tab doesn't offer to re-open a copy of itself.
  - `entrypoints/_shared/components/LandingPage.tsx` and `RightRail.tsx` — pass `openInNewTab` at the three Space workspace-file viewer call sites (xl rail, stacked rail, and the sidebar rail).

- 4fb8763: **Fix MCP bridge trust-prompt flicker loop and stale-session reconnect wedge.**

  Two related reliability fixes in the extension↔broker WebSocket handshake:

  - **`hello-defer` stops the trust-prompt flicker.** The broker armed a fixed 5s `hello-timeout` after sending `hello-challenge`, but first-run TOFU (and key-rotation) require a _human_ to approve the broker's identity in the extension UI — which can't happen in 5s. The broker would close the socket, the extension would reconnect and re-prompt, and the "verify this MCP helper" dialog flickered on/off every few seconds, making pairing nearly impossible. The extension now sends a `hello-defer` message the moment it needs a human decision; the broker cancels the short timeout and holds the socket open under a generous trust-decision window instead. The fast-fail path is preserved for genuinely dead/hung connections (the common already-trusted case still answers in milliseconds).

  - **Pong-based liveness eviction unwedges reconnects.** The broker enforces a single active session and rejects a second connection with `session_already_active`. If the paired extension's socket died _uncleanly_ (MV3 service-worker suspend, sleep/wake, network blip — no TCP FIN), the broker kept the session registered and rejected every reconnect until the OS TCP stack timed the dead socket out (minutes), leaving the panel stuck on "Not connected." The broker now pings each established session and terminates a socket that misses a pong, so a dead session self-clears within ~1–2 heartbeat intervals and the extension can re-pair. The heartbeat interval is configurable via `heartbeatIntervalMs` (default 20s).

  Tests: broker WS suite covers the deferred-then-completed handshake and dead-peer eviction; the extension connect suite covers sending `hello-defer` on both the TOFU and key-mismatch paths.

## 0.13.3

### Patch Changes

- 4e2edbd: **Fix plan-approval flow under SW-host (regression): the approval card mounts again and approving a plan updates the same assistant bubble in place.**

  PR #176 (MCP subagent bridge) inadvertently reverted the coordinated fixes
  landed in #174, reintroducing two user-visible regressions on the
  post-`proposePlan`-approval path (and every approval-gated Ask-mode tool):

  1. **Approval card never appeared; the tool jumped straight to "Interrupted."**
     The SW agent host's `healLastAssistantInChatDb` ran on every run-termination
     path — including the natural pause-for-approval path — and rewrote
     `approval-requested` parts to `output-denied` in chat-db. The renderer then
     re-hydrated the in-memory message list from chat-db, so
     `findPendingPlanApproval` returned null and `PlanApprovalCard` never mounted;
     Ask-mode prompts rendered as denied before the user could act.

  2. **Approving a plan left the original bubble stuck at "Drafting plan…"**
     The renderer's `CompactingChatTransport` minted a fresh `crypto.randomUUID()`
     as the assistant message id on every call — including resumes — overriding the
     AI SDK's `getResponseUIMessageId` continuation logic. The post-approval
     `output-available` chunk landed in a NEW assistant message, leaving the
     original `proposePlan` part stranded in `approval-responded` ("Drafting
     plan…") while a duplicate row appeared below it.

  Fixes (re-applied from #174 onto the post-#176 tree):

  - `entrypoints/background/agent-host/heal-chatdb.ts` — `healSerializedParts`
    again leaves `approval-requested` parts untouched. The SDK pauses there
    intentionally; healing it treats a legitimate resting state as an
    interruption. Renderer-side `healPendingTools` still collapses
    `approval-requested → output-denied` on the next user action, which is the
    correct point.
  - `lib/agent/compacting-transport.ts` — both the fast path and the
    rejection-loop path again pass `originalMessages` to
    `result.toUIMessageStream({ ... })`, so the SDK reuses the last assistant
    message's id on resume and extends the existing bubble instead of pushing a
    duplicate. Fresh turns (last input is a user message) still get a new UUID.
  - `entrypoints/background/agent-host/run.ts` — `pumpMessages` again threads the
    input transcript's trailing assistant message into
    `readUIMessageStream({ message })`, seeding the SW persister's `state.message`
    with the existing parts before resume chunks layer on top.

  **Known follow-up (out of scope).** #174 also closed a reload-race in the brief
  post-approval window (a `persistApprovedAssistantMessage` write in
  `useAgentChat.ts`). #176's rewrite of that hook removed the helper; re-applying
  it against the new architecture is deferred to a separate change. The two
  regressions above — the ones users hit in Plan and Ask mode — are covered here.

  **Test surface.** Restored the `heal-chatdb.test.ts` regression guards pinning
  the `approval-requested`-is-not-a-heal-target contract, including the
  end-to-end pending-`proposePlan` case. All agent-host and transport suites pass;
  typecheck clean.

## 0.13.2

### Patch Changes

- d707969: **Fix Notion connector "Failed to connect" by updating the hosted MCP URL to notion.com.**

  The Notion connector definition pointed at `https://mcp.notion.so/mcp`, which no longer resolves — DNS lookups for `mcp.notion.so` fail outright. Notion moved its hosted MCP endpoint to `https://mcp.notion.com/mcp`.

  Because the very first request in `discoverOAuthMetadata` (the `GET` against the MCP URL to read `WWW-Authenticate: resource_metadata=...`) never got a response, every downstream fallback path in `handleOAuthStart` also failed against the same dead host, and the entire flow rejected with a fetch error before `chrome.identity.launchWebAuthFlow` was ever reached. The user saw an immediate "Failed to connect Notion" toast the moment they clicked Connect.

  Verified the corrected host end-to-end:

  - `GET https://mcp.notion.com/mcp` → `401` with `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", ...` — matches the RFC 9728 discovery path OpenBrowse already implements.
  - The resource metadata declares `authorization_servers: ["https://mcp.notion.com"]`.
  - `GET https://mcp.notion.com/.well-known/oauth-authorization-server` returns full RFC 8414 metadata: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, PKCE (`S256`), and `grant_types_supported: ["authorization_code", "refresh_token"]` — so both the initial exchange and silent refresh-after-SW-restart paths are supported.

  Fix: `packages/connectors/src/notion.ts` — change the `url` field from `https://mcp.notion.so/mcp` to `https://mcp.notion.com/mcp`. No other files reference the old host.

## 0.13.1

### Patch Changes

- 63e166a: **Fix Plan-mode approval flow under SW-host: the plan approval card now mounts, approving a plan updates the same assistant bubble in place, and reloads no longer resurface the approval prompt.**

  Three regressions introduced by the service-worker-hosted agent migration, all surfacing on the post-`proposePlan`-approval path. The user-visible symptoms:

  1. **Plan approval card never appeared.** In Plan mode the agent's first action is `proposePlan`, which pauses the stream for user approval. The SW agent host's `healLastAssistantInChatDb` ran on every run-termination path — including the natural pause-for-approval path — and rewrote `approval-requested` parts to `output-denied` in chat-db. The renderer's STREAM_DONE handler then re-hydrated the in-memory message list from chat-db, replacing the `approval-requested` part with the healed `output-denied` one, so `findPendingPlanApproval` returned null and `PlanApprovalCard` was never mounted. Same regression hit every approval-gated tool in Ask mode (navigate to a fresh origin, executePython, closeTabs, etc.).

  2. **Approving a plan spawned a duplicate assistant bubble.** When the user clicked Approve, the SDK's `sendAutomaticallyWhen` triggered a resume `sendMessage`. The renderer's `CompactingChatTransport` minted a fresh `crypto.randomUUID()` as the assistant message id on every call — including resumes — overriding the AI SDK's built-in `getResponseUIMessageId` continuation logic (which reuses `originalMessages.at(-1).id` when the last input is an assistant). The post-approval `proposePlan` `output-available` chunk plus the next tool's start landed in a NEW assistant message instead of updating the existing one, leaving the original bubble stranded in `approval-responded` ("Drafting plan…") forever and showing a duplicate "I'll propose a plan first" bubble below it.

  3. **Reload during the brief post-approval window resurfaced the approval card.** `addToolApprovalResponse` only mutates local Chat state; nothing wrote the renderer's `approval-requested → approval-responded` flip back to chat-db. Until the SW resume run produced enough output for the persister to overwrite the row, chat-db still had the part in `approval-requested`. A reload in that window made `findPendingPlanApproval` re-surface the card against a decision the user had already made.

  Fixes:

  - `entrypoints/background/agent-host/heal-chatdb.ts` — `healSerializedParts` now leaves `approval-requested` parts untouched. The SDK pauses there intentionally; healing them treats a legitimate resting state as an interruption. Renderer-side `healPendingTools` still collapses `approval-requested → output-denied` on the next user action (edit / retry / regenerate), which IS the correct point — by then the user has implicitly abandoned the prompt. `approval-responded`, `input-streaming`, and `input-available` heals are unchanged.
  - `lib/agent/compacting-transport.ts` — both the fast path and the rejection-loop path now pass `originalMessages` to `result.toUIMessageStream({ ... })`. The SDK's `getResponseUIMessageId` then reuses the last assistant message's id for the resume's start chunk, so `Chat.makeRequest`'s `replaceLastMessage` invariant (`state.message.id === this.lastMessage.id`) holds and the SDK extends the existing assistant message instead of pushing a duplicate. Fresh turns (last input is a user message) still fall through to `generateMessageId` for a brand-new UUID.
  - `entrypoints/background/agent-host/run.ts` — `pumpMessages` threads the input transcript's trailing assistant message into `readUIMessageStream({ message })` so the SW persister's `state.message` is seeded with the existing parts (proposePlan input + approval metadata) before resume chunks layer on top. Without this, the SW would write a chat-db row containing only the resume stream's chunks, wiping the input + approval fields that the UI needs to render the post-approval state correctly.
  - `hooks/useAgentChat.ts` — `approveToolCall` now persists the flipped assistant message to chat-db immediately after calling `addToolApprovalResponse`. This closes the reload-race window. Extracted as `persistApprovedAssistantMessage` for direct testability; preserves existing `createdAt` and `summary` metadata when the row already exists, creates the row otherwise.

  **Out of scope.** Viewer-surface approvals (the case where a non-initiator tab clicks Approve and the decision is forwarded to the SW via `AGENT_APPROVE`) still have the brief reload-race window — that path needs the equivalent persist on the SW side, deferred to a follow-up. The initiator path (the common case) is fully covered.

  **Test surface.** +9 tests, all 2,173 pass: `compacting-transport-resume-id.test.ts` (3 tests covering `originalMessages` plumbing in fast path + rejection-loop), `hooks/__tests__/persistApprovedAssistantMessage.test.ts` (5 tests covering approve/deny persistence, unknown toolCallId, createdAt preservation, and no-prior-row race), an in-place regression test in `agent-host/__tests__/run.test.ts` for `readUIMessageStream({ message })` resume seeding, plus updated `heal-chatdb.test.ts` regression guards that pin the approval-requested-is-not-a-heal-target contract.

## 0.13.0

### Minor Changes

- 441dcf1: **Artifacts.** The agent can now build self-contained mini-apps — dashboards, widgets, interactive HTML tools — and you can open them as a tab or pin them in your workspace. Ask for "a tool that…", "a dashboard for…", or "an app that shows…" and the agent writes a single sandboxed HTML+JS artifact, then verifies it actually renders before handing it back.

  **Sandboxed runtime.** Artifacts run in an isolated, opaque-origin iframe with no access to your browser, extension storage, or other pages. They reach the outside world only through a small `window.openbrowse` bridge: scoped key/value storage, brokered `fetch` (routed through the extension so artifacts avoid third-party CORS proxies), and the browser/MCP tools you've granted. A per-artifact permission manifest gates network hosts and write-capable tools; expanding that surface re-prompts for your approval. Artifacts follow your light/dark theme automatically.

  **Pinned dependencies.** Artifacts may load a small allowlist of pinned libraries (Chart.js, Grid.js, Mermaid, D3) from a trusted CDN; the script tags carry Subresource Integrity hashes so a tampered or swapped file is rejected by the browser.

  **Workspace & editing.** New artifacts open in a side-rail viewer with a rendered/source toggle and a live console. Use **Edit this artifact in chat** to revise an existing one — the agent makes surgical edits rather than rewriting the whole file — or **Fix with OpenBrowse** in one click when an artifact throws an error.

- 194ed81: **Service-worker-hosted agent runs.** The agent loop has moved out of the renderer and into the MV3 background service worker. Previously, the AI SDK chat loop, tool execution, persistence, and indicator state all lived inside whichever React surface (side panel, home tab, new-tab page) initiated the turn — so closing that surface mid-turn killed the run, opening a second surface created a duplicate competing loop, and switching tabs while the agent worked could orphan tool calls. The whole thing now runs in the service worker as a single deterministic host per conversation; every renderer is a thin viewer subscribing over a `chrome.runtime.Port` named `agent-run:<conversationId>`.

  **What this changes for you.**

  - **Closing a tab no longer interrupts the agent.** Start a task in the side panel, close the panel, open the new-tab page — the agent keeps running and you see the live transcript wherever you re-open the conversation.
  - **Parallel chats stay independent.** N conversations can run concurrently across the home tab, new-tab page, and per-tab side panels without surfaces stepping on each other (no more "the panel I'm watching froze because another conversation finished" desync).
  - **Queued messages flush deterministically.** Queue a follow-up while the agent is running, press Esc to stop the current turn, and the queued message dispatches as soon as the SW finishes its teardown — no more silently-stuck queues across tab/space/window boundaries.
  - **The "agent is working" blue dot survives backgrounding.** The sidebar dot, in-chat sparkle, and per-tab overlay now reflect the SW's authoritative state instead of the renderer's local React state, so the indicator stays accurate while you're on another tab and while tools are executing between text turns.
  - **Approvals route to the live owner.** Approve / deny from any renderer; the click is forwarded to the SW which applies it to the actual `approval-requested` part. Viewers can stop the run too — a viewer's Stop button now sends `AGENT_RUN_STOP` to the SW host, not just to the (idle) local SDK.
  - **Tool execution is durable.** `navigate`, `close-tabs`, MCP connector tools, Python/sandbox execution, skills, subagent delegation, and CUA all run inside the SW realm now. Tools that need a specific tab (capture, debugger-attached actions) use a new `tab-binding-rpc` channel to drive the target tab remotely.

  **Crash + restart recovery.** When the SW is evicted mid-run (Chrome memory pressure, browser update), chat-db's last assistant message can be left with `input-streaming` / `approval-requested` tool parts. On the next user action, a heal pass rewrites those to `output-error` with a muted "Interrupted" badge, so you can resume the conversation cleanly instead of getting stuck behind unmatched tool calls. `resetActiveAgentsAtStartup` clears stale "agent is running" flags at SW boot so the composer never opens with a stuck Stop button.

  **Implementation highlights.**

  - `entrypoints/background/agent-host/` — new package: `registry.ts` (one `RunHandle` per conversationId), `run.ts` (drives a single turn end-to-end, tees the chunk stream into fan-out + persistence + snapshot pipelines), `port-router.ts` (handles `chrome.runtime.onConnect` for `agent-run:*` ports, ACKs `hasActiveRun`, folds duplicate STARTs into viewer attaches), `snapshot-broadcast.ts` (throttled `STREAM_PARTS` + terminal `STREAM_DONE` for viewer surfaces), `heal-chatdb.ts` (SW-side healer for stranded tool parts on run termination), `bootstrap.ts` (wires the lot at SW boot).
  - `lib/agent/remote-transport.ts` — new renderer-side `ChatTransport` (`RemoteChatTransport`) that proxies `Chat.sendMessage` to the SW host over a port, plus `probeAgentRun` / `probeAgentRunAwaitIdle` / `abortAgentRun` helpers used by `handleSubmit`, the queue auto-flush watcher, and the wrapped `stop()`.
  - `hooks/useAgentChat.ts` — viewer-aware: `isInitiator` = "this surface's local `useChat` is driving"; `isLoading` = "any surface (or the SW alone) is driving" — used for spinner + Stop button visibility; `isStreaming` is synced to `isLoading` so tools don't flash "Interrupted" while the SW is between text deltas. STREAM_DONE drops viewer mode unconditionally. The queue auto-flush effect lists `isViewer` as a dep so it re-arms when the SW finishes a long run. `isFlushingRef` was removed — `queueDb.claimHead` is the authoritative lock, the React ref was racing the SW finally block.
  - `entrypoints/background/agent-host/run.ts` finally-block — when an old run terminates and the renderer's queue watcher has already started a new run on the same conversation, the old finally backs off instead of calling `resetAgentIndicator` (which would tear down the new run's blue dot and abort its mid-flight tools globally). `healLastAssistantInChatDb` runs **before** `emitDone`/`emitError` so subscribers never see a tool flash as "Interrupted" against the new run's already-persisted message.
  - `port-router.ts` — on a fresh `AGENT_RUN_START`, evicts any terminal-status handle whose finally block hasn't yet reached `registry.release` so the new run can register without throwing.

  **Test surface.** 1,893 tests pass. New coverage: `agent-host/__tests__/*` (registry, run lifecycle, port router, snapshot broadcast, heal-chatdb), `lib/agent/__tests__/remote-transport.test.ts` (24 tests covering chunk pump, abort semantics, port-disconnect Chrome quirks, `probeAgentRun`, `probeAgentRunAwaitIdle`, `abortAgentRun`), `lib/agent/__tests__/agent-indicator-parallel-tabs.test.ts`, `lib/agent/__tests__/conversation-window-resolution.test.ts`, `lib/agent/__tests__/active-tab-per-cid.test.ts`, `lib/agent/__tests__/tab-binding-rpc.test.ts`, `lib/agent/__tests__/sw-import-graph.test.ts` (guard against accidentally pulling browser-only modules into the SW bundle), `lib/agent/subagents/__tests__/subagent-runs-in-sw.test.ts`, `lib/active-agents-startup-reset.test.ts`, and dispatch tests for the MCP / skills / Python / sandbox SW message channels.

## 0.12.0

### Minor Changes

- 58dd402: **Approval modes.** A new picker in the chat composer lets you pick how the agent gets your permission per conversation: **Ask before acting** (the default — pause and approve each gated action), **Plan before acting** (the agent proposes a plan once; you approve it; it executes within those bounds), and **Act without asking** (no approvals — use only on trusted, repeated workflows). Press **⌘.** to cycle modes from the keyboard.

  **Plan mode in detail.** When you're in Plan mode, the agent's first action is always to draft a plan: a goal, the sites it intends to touch, the steps it'll take, and whether it needs network access via Python. The plan card replaces the chat composer so you can review and approve in one keystroke (Enter). If the agent later needs to touch a site you didn't approve up front, you'll be asked once — and that approval extends the plan for the rest of the conversation, so you don't get prompted again for the same site. Extensions show up inline in the chat as small "Plan extended: example.com" notices so you can see the boundary moving. Subagents the planning agent delegates to inherit the same plan, so the boundary you approved binds transitively.

  **Verified-read fast path for `executeOnPage`.** Inline JavaScript the agent runs against a page now declares whether it's reading or writing. Read-shaped scripts — that don't click, type, fetch, mutate the DOM, modify storage, or navigate — skip the approval prompt entirely (a static AST check on the script body is the trust mechanism, no allowlist required). Write-shaped scripts behave like before: skip approval on origins you've explicitly trusted, prompt elsewhere. The agent gets clearer guidance about which shape to declare. Net effect: fewer prompts on routine scraping/extraction tasks.

  **Act mode safety floor.** Even in Act mode, calling Python with network access still requires approval if your conversation's plan said network was off-limits — and approving once flips the plan permanently for that conversation, so you're not re-prompted on every subsequent network call.

### Patch Changes

- 27c34d6: **Fix `clickElement` stalling indefinitely when chatting from home / new tab, and lift Chrome's background-tab throttling on every worked tab.**

  When the user submitted a message from `home.html` or `newtab.html`, the agent's `clickElement` tool would freeze in the "pending" state until the user manually switched to the tab the agent was working on — at which point the click would finally complete and the agent would resume. Root cause: `viewport.waitForLayoutFlush` issued an in-page `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))` via CDP `Runtime.evaluate { awaitPromise: true }`, and Chrome throttles `requestAnimationFrame` to ~1 Hz then 0 Hz on backgrounded tabs. The intended `timeout: 1000` field on `Runtime.evaluate` is silently dropped by Chrome (the field exists for `Runtime.callFunctionOn`, not `Runtime.evaluate`), so the await actually had no bound — the click pipeline hung until rAF fired again, which only happened when the tab became visible.

  Fixed at three layers, complementary not redundant:

  - `cdp-session.attach` now issues `Emulation.setPageVisibilityOverride { visibility: "visible" }` and `Page.setWebLifecycleState { state: "active" }` on every CDP-attached tab. The page sees `document.visibilityState === "visible"`, so Chrome stops throttling rAF, `setTimeout`, and the lifecycle freeze that bites long-running background tabs. Both calls are best-effort (some targets reject the override) and need no detach reciprocal — Chrome resets them when the debugger detaches.
  - `viewport.waitForLayoutFlush` now races the `Runtime.evaluate` call against a host-side 1500 ms `setTimeout`. Even if the visibility override doesn't take effect for some reason (Chrome version regressing the override, page using `requestPostAnimationFrame`/compositor timeline that's compositor-paused), the click pipeline can never wedge — proceeding with a slightly-stale layout read is strictly better than hanging. Drops the misleading unused `timeout: 1000` CDP field.
  - `capture-utils.captureScreenshot`'s `-32000 Unable to capture screenshot` retry path now flips `captureBeyondViewport: true` for the second attempt (when not already set). The off-screen renderer path doesn't depend on a fresh compositor frame, so it succeeds on tabs whose compositor has paused — the dominant `-32000` cause in production. Retry without the 600 ms wait in this case (the wait only helped the legacy "renderer mid-paint" race, not compositor pause).

  Net effect: agent tools (clickElement, screenshot, executeOnPage with in-page awaits, CUA loop captures) all run at foreground speed on backgrounded worked tabs, no matter which surface the user is chatting from.

- 7be3dfa: **Fix overlapping Memory cards in Settings.**

  The Memory tab's User Memories and Space Memories sections were rendering on top of each other — the space section's heading visually overlapped the last User Memories card, and the empty-state text appeared in the wrong place. Cause: each list was wrapped in a Radix `ScrollArea` with `max-h-[300px]` but no fixed height, so `ScrollArea.Root` collapsed to 0px while its absolutely-positioned content painted out of flow. Removed the inner scroll regions; the settings panel already has its own outer scroll container, so the two `<section>`s now flow normally with correct spacing.

- 6e8552e: Make the Anthropic `tool_use.input: Input should be a valid dictionary` error structurally impossible.

  The bug: Opus (and any provider) sometimes emits a non-object `input` for a tool call — most commonly `input: ""` for a no-arg MCP tool like Attio's `list-attribute-definitions`. The Anthropic API rejects it with HTTP 400; Gemini coerces it silently, which is why the same conversation 400'd on Opus but worked when retried on Gemini. Once the bad shape was persisted to chat-db, every subsequent send failed until the row was manually purged.

  This change closes the failure path at five layers — any one of which would have prevented the bug, and all five together make it impossible to recur from any direction:

  1. **`tool-input-normalize.ts`** — new module with a recovery ladder applied at every outbound and persisted boundary. Recovers a stringified-JSON object input (Opus quirk), falls back to `rawInput`, and rescues no-arg MCP tools by coercing `""` / `null` / `42` / `[]` to `{}` when the tool's schema accepts an empty object. Irrecoverable values (e.g. `""` for a tool with required fields) are dropped rather than producing a malformed `tool_use` on the wire.
  2. **`mcp/schema-to-zod.ts`** — tightened so every MCP tool's resolved Zod schema is a top-level `z.object({...})`. A non-object input now fails `validateUIMessages` structurally instead of slipping through the previous `z.any()` / `z.record(...)` fallthroughs. Property-level `passthrough()` keeps MCP-server schema drift forward-compatible. Adds support for `additionalProperties`, n-ary `oneOf` / `anyOf`, `allOf`, `format` (uuid / email / url / date-time), `const`, multi-type `type`, and tuple-form `items`.
  3. **Persistence sanitization** — `serializeParts` and `deserializeToolPart` route every tool part's `input` through the normalizer, so a non-object value never reaches chat-db (or, for legacy rows, never reaches the live UIMessage list).
  4. **chat-db v16 migration** — sweeps every persisted message's parts on first open and either recovers (stringified-JSON / rawInput → object) or excises any tool part with a malformed input. Fixes already-broken conversations without user action.
  5. **Last-mile assertion** — `assertModelMessageToolInputs` runs immediately before `agent.stream(...)` (both fast-path and rejection-loop). If a non-object `tool_use.input` somehow slips through layers 1–4, it's coerced to `{}` in place and a `console.error` logs the model-message index, content-block index, tool name, and offending value — converting "the agent mysteriously 400'd on Opus once last week" into a one-look DevTools entry.

  Bench harness (`packages/bench/src/agent/headless-chat.ts`) gets the same normalization on its `tool-call` chunk path so future regressions surface in `pnpm bench`.

  109 new tests, 6 in a dedicated end-to-end regression suite (`opus-input-bug-regression.test.ts`) that exercises the full pipeline with real-world Attio-style MCP tool schemas. All 1496 tests pass; type checking clean.

- 1ba8462: **Sidebar polish + clearer "agent is working" indicator.**

  - Clicking the toolbar icon now toggles the side panel, replacing the previous spotlight overlay. Works on every page including `chrome://` URLs where the overlay couldn't inject.
  - Removed the redundant logo button from the side panel header — the sidebar already conveys the app context, and `Alt+H` still opens the home view.
  - The "Retry from this message" dialog now advertises and accepts `⌘⏎` (or `Ctrl+Enter`) as a confirmation shortcut, matching the rest of the app's keyboard conventions.
  - A pulsing blue pixel-art sparkle now marks the active assistant turn from the moment you hit Send through the end of streaming. It replaces the old gray bouncing-dots bubble during the "submitted" phase and stays visible at the end of the streaming text — gating on the local-stream signal so it doesn't disappear in the brief window between agent-start and first token (a regression caused by the cross-tab `isAgentActiveGlobally` flag flipping `isStreaming` on prematurely).

## 0.11.0

### Minor Changes

- eba409b: **Chat from any new tab.** Cmd-T (or any new tab) now opens straight into a chat surface — same composer, sidebar, and conversation list as the pinned home tab, sharing all your chats and spaces. Cmd-N still opens to a single pinned home tab as before. The pinned home tab keeps its existing role as the durable space anchor and scheduled-run host; new tabs are an additional, ephemeral on-ramp into the same UI. Each new-tab chat shows the conversation title in Chrome's tab strip so you can tell several open NTPs apart at a glance, and the chat input grabs focus the first time you click the page or hit Tab/Escape on the omnibox.

  **Fix:** the `⋮` menu on Space cards and on the active-space row in the sidebar now opens correctly. The trigger button was silently dropping the click that toggles the menu, so the Delete action was unreachable.

- b5502d8: **Spaces are now projects.** Each Space carries its own instructions, files, memories, and skills — a self-contained working context for one kind of work (a client, a research topic, a side project). Configuration lives **inline on the chat landing page**: a sticky header with the Space's icon, name, description, and color, plus a right-rail panel for Instructions / Files / Memory / Skills. The standalone "configure space" detail page is gone; you no longer leave chat to tweak a Space.

  **Two workspaces: per-chat and per-Space.** Every conversation still has its own working folder where the agent writes files by default — that doesn't change. What's new is that each Space gets its own **shared** workspace that's visible to every conversation bound to it. The agent can read it freely; writes to it go through approval. When a file the agent produced in a chat is worth keeping around, **save it to the Space** with one click and it gets promoted into the shared workspace; re-saving overwrites the same destination instead of stamping `(2)`/`(3)` duplicates. A small indicator on each working-folder file shows whether it's unsaved, saved, or stale (the source has changed since you saved). Files dropped on a Space's landing page upload straight into the shared workspace; clicking any file card opens it in a viewer in the same right rail (no new tab, no modal).

  **Memory is scoped per Space (or global).** When the agent records a memory mid-conversation, it goes to the active Space by default; ask it to save a memory globally and it lands in your user-wide memory instead. Recall returns up to two matches — the global one and the space-scoped one — so a same-titled space memory never hides a global one. Each Space's memories show up in its rail, and global memories stay in Settings.

  **Skills are scoped too.** Each Space picks which personal skills are active for its agent (built-ins are always on). Install a skill from a URL or upload one as a `.zip`/`.tar.gz` directly from the Space's rail.

  **No-Space conversations are first-class.** Starting a chat without picking a Space no longer forces a default Space onto you — chat works without one, and the side panel and home both reflect that.

  **Per-conversation file references.** As the agent reads from a Space's workspace, the conversation records which files it touched. The Context card in the rail surfaces them as clickable cards so you can jump back to the exact file that informed the answer.

  **Reload-safe URLs.** The home page now hash-routes (`#chat` / `#scheduled` / `#spaces` / `#<conversationId>`) and Settings query-routes (`?tab=…`), so reload, Back, and Forward all land you back where you were.

  **Sidebar refresh.** Logo + Space name is now a single Go-home button; a dropdown beside it surfaces per-Space actions. The version stamp sits next to the logo when no Space is active.

  **Composer halo.** The chat composer paints a soft gradient halo in the active Space's color on focus — dimmed to 60% opacity in dark mode so saturated colors don't read as glaring.

  **Card-grid Spaces page.** The Spaces tab is now a card grid sorted by recent activity. Press `/` to focus the search; Esc clears it. Click a card to open that Space.

  **Scheduled view parity.** The scheduled-tasks page now matches the Spaces page visually — same card grid, same `/`-focus search, same dashed-border empty state.

## 0.10.0

### Minor Changes

- 4fad594: OpenBrowse now learns from your browsing. As your agent works through a task, it watches what worked and quietly saves reusable scripts and notes per site (LinkedIn, Luma, X, Notion, etc.) so the next time you're on the same site, the agent picks up where it left off — knowing the page's quirks, where content lives, which API to call. You don't have to do anything; this happens in the background after each successful task.

  **See what's happening in the page.** Two new tools, `read_network_requests` and `read_console_messages`, let the agent inspect a page's API calls and JavaScript errors in real time. Useful when you ask it to debug a broken page, find an undocumented API, or scrape data from a site that loads everything via fetch. The agent now also catches when a click "missed" because of an overlay versus when it actually worked but looked like it missed — fewer wasted clicks, fewer redundant retries.

  **Faster, more reliable script execution.**

  - `executeCode` and `executeOnPage` now save big results straight to your workspace when you ask for it, instead of stuffing JSON into the chat.
  - `executeCode` supports modern async/await and a configurable timeout (up to 2 minutes) — handy for batched API calls.
  - The agent gets clearer guidance about when to run code in the page (with the page's cookies) versus in a background sandbox (without them) — fewer "Failed to fetch" loops on logged-in sites.
  - After saving a file to workspace, the agent now sees that file in its context every turn — so it doesn't forget what it already wrote and re-do the work.
  - When the agent loses track of which tab it's working with, the error now lists every open tab right inline — so it recovers instantly instead of asking around.

  **Workspace tooling.** A new `Delete` action lets the agent clean up files it no longer needs (with safety rails on `/skills/` and `/.uploads/`). You can now copy a chat as Markdown or export it to a `.md` file from the chat header. The cowork bar — the floating Plan/Files/Context strip — is now side-panel-only since the home view has the same info in its right rail.

  **Cancel with double-tap Esc.** Press Esc twice (within half a second) to stop the agent mid-task. A small "Press Esc again to interrupt" hint appears above the composer the first time so you know it's armed. Replaces the old Cmd+Shift+Backspace shortcut, which was hard to discover and didn't work everywhere.

### Patch Changes

- 4fad594: Fewer false "let me try again" moments at the end of a task.

  OpenBrowse runs a quick "did the agent actually finish?" check before handing the answer to you. That check used to second-guess the agent on things it had no good way to verify — like whether the agent's claim was backed up by the (heavily truncated) tool-call log. When the agent saw something on the live page that the log later cut off, the check would treat the missing evidence as fabrication and bounce the agent back to keep working. The result: completed tasks getting unnecessarily redone.

  The check now focuses on what it can actually judge: did the agent address what you asked for, did it close out its own plan, and did it stop short instead of finishing? The fabrication- and page-state-checking dimensions are gone. The check still defaults to skeptical and still defers to what the agent saw — it just stops rejecting answers based on absent evidence.

## 0.9.2

### Patch Changes

- b7c3e10: Make CDP frame-walking calls (`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`) resilient to cross-extension iframes that the debugger isn't permitted to inspect.

  Symptoms this fixes:

  - "Cannot attach debugger to tab N: No tab with given id N" cascading across every action on http(s) pages where another installed Chrome extension (e.g. **1Password**, LastPass, Bitwarden, Honey, Grammarly) has injected a content-script iframe served from `chrome-extension://<otherExtId>/`. Chrome refuses cross-extension debugger access and detaches the whole session as collateral, which made every snapshot fatal until the page was closed.
  - Misleading `No tab with given id` errors that read like a prerender / Speculation Rules failure (handled separately by #139) but were actually caused by a hostile iframe.
  - Repeated "post-action snapshot failed" warnings on sites with many embedded forms where a password manager aggressively injects.

  What changed:

  - New `isCrossExtensionFrameError` classifier in `cdp-errors.ts`. The detach classifier (`isDetachError`) explicitly does NOT match this class, so the existing detach-and-retry path can never accidentally tear down a healthy session for a per-call iframe failure.
  - `cdp-session.ts` bails early on cross-extension errors at both catch sites (`<Domain>.enable` and the actual command). The session is left intact; the error bubbles to the caller.
  - `snapshot-capture.ts` adopts a two-tier AX-walk strategy:
    - **Tier 1 (primary)**: a single whole-tree `Accessibility.getFullAXTree()` call. Chrome stitches the AX tree across frames on its end, preserving legitimate iframe content (Stripe, YouTube, embedded forms, etc.). On benign pages and on most pages that have a foreign extension iframe loaded but not actively in the AX walk, this is the only CDP round-trip taken — no additional cost vs. the legacy code.
    - **Tier 2 (fallback, only on cross-extension rejection)**: `Page.getFrameTree` to enumerate frames, then `Accessibility.getFullAXTree({frameId: <main>})` to walk just the main frame. Legitimate child-frame content is unavailable in this mode; the agent is told via `note`.
  - `buildTree` returns a synthetic empty root when given zero AX nodes (instead of dereferencing `nodes[0]`), so an all-frames-hostile page produces an empty snapshot rather than crashing.
  - New `note` field on `CaptureResult`, propagated through `snapshot`, `clickElement`, `typeInElement`, `pressKey`, and `navigate`. When frames were excluded the agent receives a short, agent-actionable message naming the offending extension hosts. The note language is split into two cases so attribution is honest:
    - Foreign-only exclusions: lists the cross-extension hosts and confirms the main page is unaffected.
    - Raced/main-frame failures: reports "frames errored mid-walk" without speculating about which extension owns them, and recommends a retry.

  Tests added:

  - `cdp-errors.test.ts` — classifier coverage on every Chrome error string we've seen in the wild + the mutual-exclusion invariant against `isDetachError`.
  - `cdp-session-cross-extension.test.ts` — confirms the session map is NOT mutated and no retry runs when a cross-extension error fires from either `<Domain>.enable` or the command itself.
  - `snapshot-capture-cross-extension.test.ts` — Tier 1 happy path (no frame-tree round-trip), legitimate child-frame content preserved across the merge, Tier 2 fallback semantics (main-frame-only walk, no other safe frames walked, attribution note correct), soft language when the main frame itself races, and the generic note when `Page.getFrameTree` is unavailable post-rejection.

- 5b07aa6: Data plumbing: `saveAs` on `executeOnPage`/`executeCode`, atomic workspace writes, removed `executePython`'s `input` parameter.

  Three execution sandboxes in the extension (`executeOnPage`, `executeCode`, `executePython`) share no filesystem — they're each in different origins, and only `executePython` has access to `/workspace` (the conversation's OPFS). The agent had no first-class way to move bytes between them, so it would route data through chat context: a tool returns a string, the agent sees it, the agent calls another tool with the string as an argument. For payloads larger than a few KB this bloats context, triggers truncation, and pushes the agent into ad-hoc transports (chunk-and-stitch, base64, browser downloads, CORS proxies). One real chat hit 30+ tool calls trying to move a 62 KB JSON between `executeOnPage` and `executePython`.

  This change adds a `saveAs: "<path>"` parameter to both `executeOnPage` and `executeCode`. When set, the script's return value is written directly to `/workspace/<path>` by the host, and the tool result is `{ path, bytes, sha256 }` (plus `tab` or `logs`) instead of the data — so the bytes never enter chat context. Strings are written as text; binary content uses the envelope `{ __binary_b64: "..." }`. Writes go through new `OPFS.writeFileAtomic` / `writeFileBytesAtomic` helpers that stage to a `<path>.tmp-<rand>` sibling, so a producer crash mid-serialize never truncates a previously-good file.

  Companion: removed `executePython`'s `input` parameter. Its description ("JSON-encoded data made available as the Python global `__input`") read like the canonical channel for passing data into Python, but the parameter only worked for small JSON-shaped payloads and silently failed on `JsProxy` values, which sent agents into spirals when they mistook it for the right transport. With `saveAs` and the existing `Write` + `/workspace` path, `input` was redundant. Skills that referenced it (`python-env`, `csv-to-markdown` in `writing-skills`) have been updated to the file-based pattern.

  New `data-plumbing` skill documents the canonical recipes (page → /workspace → Python), the three-sandbox model, anti-patterns from past failures, and recovery moves. Loaded by trigger phrases like "scrape this page", "build a CSV", "save the JSON".

  Sandbox 1 MB JSON-output cap is bypassed when `saveAs` is set — the cap exists to protect chat context, but `saveAs` already does that more directly.

## 0.9.1

### Patch Changes

- e085675: Tab identity continuity via `LogicalTabId` and `TabRegistry`.

  The extension now keys agent-facing tab handles, conversation ownership, and persisted state on stable `LogicalTabId`s (UUIDs) instead of `chrome.tabs.id` (which Chrome silently renumbers on prerender activation, BFcache restore, and some discard/restore paths). A new `tab-registry` module owns the only `chrome.tabs.onReplaced` listener in the codebase and consolidates the trailing `onRemoved` Chrome fires for the replaced ctid (so consumers see exactly one event, not a replace-then-remove pair).

  Symptoms this fixes in production:

  - "Unknown tab handle" mid-flow on Speculation Rules sites (Attio settings, Notion, Vercel, Google Search, X) where prerender activation renumbers the underlying tab id.
  - "Cannot attach debugger to tab N: No tab with given id N" loops in the CUA computer-use subagent, which previously cached the chrome ctid at loop start and never refreshed it.
  - Stale `chrome.tabs.id` recycling across Chrome restarts that could resolve a persisted handle to an unrelated user tab.
  - `waitForTabLoad` timing out when the navigation completed on the post-replace ctid rather than the pre-replace one.

  chatDb schema bumps to v15. The migration walks each conversation's legacy `ownedTabIds: number[]`, probes `chrome.tabs.get(ctid)` to confirm liveness, and rewrites surviving entries through the registry to `ownedLtids: string[]`. Dead ctids are dropped silently; corrupt rows degrade to empty owned-state with a `console.warn` rather than aborting the upgrade. The `handleState.handles` map is rewritten in the same pass.

  The CUA loop subscribes to the registry's `onReplace` event and updates its cached ctid in place, keeping long-running computer-use sessions alive across prerender activations. The working-overlay glow re-routes to the new ctid automatically so the user sees continuous feedback.

## 0.9.0

### Minor Changes

- 8959f4d: Surface the agent's plan, workspace files, and context in the side panel, and
  fix conversation context for new chats and subagents.

  The side-panel composer gains a cowork bar: a tabbed strip (Plan / Workspace
  files / Context) with a glanceable label, click-to-expand panels, an animated
  height, and an in-panel file viewer — so the narrow side panel gets the same
  plan/files/context surfaces the home view has in its rail. The chat header also
  gains the context-usage chip (token/cost radial + popover). The shared cowork
  cards were extracted into a common module so home and side panel render from
  one source.

  Also fixes a conversation-context bug: `executePython` and the file tools
  (Read/Write/Edit/Glob/Grep/LS) captured the conversation id in a build-time
  closure, so a brand-new chat failed with "No conversation context" and the file
  tools silently wrote to the wrong workspace root (a latent variant also
  affected subagents). They now resolve the id from the call-time tool context,
  matching the existing delegate tool.

### Patch Changes

- 8ae2bd0: Fix agent clicks being silently eaten by OpenBrowse's own "is working" overlay,
  and replace post-action diffs with viewport snapshots.

  Trusted CDP `Input.dispatchMouseEvent` events the agent dispatched were landing
  on `.ob-cua-root` — the full-viewport (`position:fixed; inset:0`) shadow-DOM
  wrapper inside the `openbrowse-cua-working-host` overlay — which had implicit
  `pointer-events: auto`. Because hit-testing climbs from a `pe:none` shield to
  its parent, the click never reached the page element underneath. Symptoms
  included FAQ accordions never expanding after `clickElement`, theme toggles
  that reported success but didn't flip, and CUA subagent clicks landing on
  nothing. Adding `pointer-events: none` to `.ob-cua-root` lets descendants with
  explicit `pe:auto` (the shield, the Stop button) keep working as hit-test
  targets while letting the agent's own dispatches pass through to the page.

  Also: `clickElement` / `typeInElement` / `pressKey` now auto-attach a fresh
  viewport-scoped accessibility snapshot in their response (replacing the legacy
  `diff` field). The diff approach hallucinated when the prior snapshot was
  viewport-scoped and the post-action capture defaulted to full-tree — the model
  saw every below-fold element as `[+] added`. The new shape is strictly more
  informative: the model can pick its next ref directly from the post-action
  state without a follow-up `snapshot` call. The `snapshot` tool keeps its
  opt-in `diff: true` mode for callers that want it.

  The click ripple now matches the active space tint, doubles in size, and uses
  a layered "dithered shockwave" animation (halo + dithered disc + 2 parallax
  rings + center spark) so the live tab gives clearer feedback when the agent
  clicks.

- 4854b5a: Fix Anthropic/Opus `tool_use.input: Field required` from failed tool calls.

  A terminal failed tool call (e.g. a failed MCP "Updated list entry") whose
  input was never captured was replayed on the next turn as a `tool_use` block
  with no `input`. Anthropic rejected the request with `tool_use.input: Field
required` (a visible "Something went wrong"); Gemini coerced it, so the bug
  only reproduced on Opus. The send-time heal now drops these input-less errored
  and denied calls before they reach the provider, while keeping any call that
  has a real input or a partial `rawInput` (which the SDK fills in).

- b1a17e4: Keep Attio/Stripe (and other OAuth) connectors authorized across extension
  updates.

  OAuth connectors were registered for the `authorization_code` grant only, so
  providers refused the later `refresh_token` token call — meaning an expired
  access token (e.g. after the service worker restarts on an extension update)
  could not be renewed silently and the connector fell back to "needs
  re-authorization". Now we register for the `refresh_token` grant too and
  request `offline_access` when the provider supports it (including providers
  like Stripe that publish no scope list but do advertise the refresh grant). An
  interactive re-auth also re-registers, repairing connectors stored by older
  builds without removing and re-adding them. Connectors whose tokens are
  long-lived (e.g. Supabase) are unaffected.

## 0.8.1

### Patch Changes

- 31d6205: Fold completed tool calls into a "Completed N steps" collapsible.

  While tools are running they stay expanded and live; once the assistant
  begins its answer text, a run of 3+ tool calls auto-folds into a
  collapsible labeled "Completed N steps" (click to re-expand), matching
  the Perplexity Comet pattern. Runs of 1-2 tools, reasoning-only groups,
  and pending approval prompts render inline as before.

- 31d6205: Fix interrupted tool calls breaking the next request.

  A tool call aborted before its arguments finished streaming was replayed
  on the next turn as a `tool_use` block with no `input`, which providers
  reject — Anthropic/Bedrock with `tool_use.input: Field required` (a
  visible "Something went wrong" error) and Gemini/Vertex with a silent
  malformed-function-call error that just stopped the generation. The
  send-time heal now drops these input-less interrupted calls before they
  reach the provider, so the conversation can continue.

## 0.8.0

### Minor Changes

- 11fa134: Add a Computer Use (CUA) subagent that lets Anthropic Claude models drive the live browser tab. Includes a provider-neutral CUA loop (canonical actions, CDP executor, coordinate mapping, screenshot zoom) with the Anthropic provider wired in, a computer-use capability flag and model picker in Settings, AI Gateway transport support, content-stable element refs, a working-on-page overlay with stop/abort, and in-place retry that continues an errored assistant turn.

## 0.7.2

### Patch Changes

- 4c11faa: Prevent multiple open tabs from auto-restarting the same agent run, and
  mirror live agent progress across tabs.

  - Disable message-load auto-resume (it made every open context restart
    the same run).
  - Add an atomic per-conversation ownership lock so only one context
    drives a run.
  - Stream full-message snapshots to other tabs as read-only viewers;
    approvals and stop are forwarded to the owner.

## 0.7.1

### Patch Changes

- 2e0bd8a: Fix extension update resilience (spaces and MCP refresh), tool state UI, and tool healing validation

## 0.7.0

### Minor Changes

- ab6a7ec: Add a `/compact` slash command to the chat composer. Typing `/` now lists
  built-in commands (under a "Commands" group) alongside skills; selecting
  `/compact` manually compacts the conversation — summarizing the full history
  and sending only that summary to the model on the next turn, while the UI
  keeps showing every original message. Supports "compact-then-send" (`/compact
<text>` compacts, then sends the remaining text) and surfaces a toast for every
  outcome (compacted, too short, or failure).

  Also fixes the compaction model resolution so it correctly handles the stored
  `provider:model` key (previously it failed to find a provider, which silently
  broke both manual and automatic compaction).

## 0.6.0

### Minor Changes

- 4630aed: Add a context-usage indicator to the chat header: a circular progress ring that shows tokens, usage %, and cost on hover, and a detailed breakdown (provider/model, context limit, token split, total cost, timestamps) on click.
- 67c8be2: Add scheduled tasks: recurring, cron-like agent runs that execute as full
  background agent sessions (DOM + chrome.debugger, system prompt, compaction).
  Driven by a bundled `/schedule` skill and `create/list/update_scheduled_task`
  tools, with a Scheduled dashboard, create/edit dialog, status badges, and a
  per-task auto-approve toggle.

### Patch Changes

- 2965aed: Fix chat input lag in long conversations. The message list is now memoized and
  extracted from the input's render path, so typing no longer re-renders every
  message (markdown + syntax highlighting) on each keystroke.

## 0.5.3

### Patch Changes

- 6f47a91: Show subagent-opened tabs in the Context card with a "Subagent" badge and
  grouped cleanup, sort sidebar chats by creation time, and open new agent tabs
  in the conversation's own window instead of whatever window Chrome has focused.
  Also fixes the Stripe MCP connector endpoint (404).

## 0.5.2

### Patch Changes

- 278b9e0: Tune the completion check to reduce false rejections and latency: the
  evaluator now runs as a single fast pass (no tool calls), accepts a
  reasonable interpretation of ambiguous requests instead of looping the
  agent, and no longer rejects page-grounded facts based on its own stale
  knowledge (e.g. "that batch doesn't exist yet").

## 0.5.1

### Patch Changes

- cf239e1: Fix agent completion/approval notification clicks to open the conversation in the tab and window where the agent actually ran, instead of the last-active window (which sometimes spawned a new window).

## 0.5.0

### Minor Changes

- 832e867: Agent can now clean up the tabs it opened: a `closeTabs` tool closes the conversation's tab group (or specific tabs you opened) with a reversible Undo toast, plus manual control over the workspace Context card. Adds a bundled `writing-skills` skill that guides the agent through authoring a new skill and installing it via `create_skill`. Also fixes `closeTabs` being rejected by the Anthropic API (its tool input schema now serializes to a top-level object), which previously broke agent turns on Anthropic models.

## 0.4.3

### Patch Changes

- 7c36ce6: Favorite tabs behave Arc-style: a favorite is recognized by hostname (adopts the first matching open tab, stays recognized while you navigate within the same site, and survives service-worker restarts); reordering favorites in the overlay now moves the real Chrome tabs and keeps them ordered between pinned and regular tabs (with bounce-back on manual reorder, returning a favorite to its own slot). Spaces now reliably reattach to their windows across browser restarts (via a durable home-tab anchor with pinned-tab fallback) instead of losing favorites and spawning new empty spaces; pinned tabs are persisted per space and reopened when a space's window is recreated (favorites are no longer auto-opened). Also: reuse an existing Settings tab instead of opening duplicates; Settings logo no longer navigates; remove Esc-closes-Settings; Models search supports "/" focus and Esc-to-clear with hints; chat-delete dialog keycap styling + optimistic removal; "Send now" on the next queued message; "Continue" action on the chat error banner; overlay footer logo respects dark mode; fix overlay logo/Actions menu close-then-reopen flash; scope the "working on this tab" blocker to the agent's actual tab.

## 0.4.2

### Patch Changes

- 610c535: Aux model picker shows all configured models; token-AND model search; fix approval-interrupt bug; expose executePython; improved MCP approval + skill-install UX.

## 0.4.1

### Patch Changes

- 6010425: Fix tool-approval "Always allow", add other-tab awareness, and assorted abort/UX fixes:

  - Respect "Always allow" by calling `needsApproval` with the AI SDK's positional `input` argument (previously `input` was always `undefined`, so the same-origin allowlist was never consulted and approval was always required).
  - Surface the user's other open tabs to the agent as an awareness-only `## Other open tabs` block. Titles/URLs are sanitized (newlines/control chars collapsed, length-capped) before reaching the system prompt to prevent prompt injection, and only `http(s)` URLs are exposed.
  - Bind the shared active tab on the first message of a new conversation so the legend marks it `[active]` immediately; the bind now honors a `{ ok: false }` background response instead of pinning an unbound tab.
  - Skip the completion check when the user aborts generation (the SDK emits an `abort` chunk and closes cleanly, which previously caused the check to grade an abandoned draft).
  - Stop TipTap from nesting pasted markdown links on each copy/paste/resend cycle.
  - Disable per-word stagger in the markdown renderer to fix concurrent/parallel reveal of streamed sections.

## 0.4.0

### Minor Changes

- dbbda3c: Subagents: the chat agent can now delegate focused tasks to specialized subagents that run with fresh context, their own tool allowlist, and isolated tab/window state.

  - **`explore`** — read-only research subagent. Use for background investigation that should not mutate state.
  - **`general`** — read/write subagent for general-purpose delegation when the parent's tools fit but the work would bloat the parent's context with verbose output.

  Each delegation appears inline as a collapsible trace block with a live transcript, a step counter, and a phase title the subagent updates as it works. Subagents run with isolation: `peer` puts the child in its own tab group within the same window (default), and `incognito` opens a fresh incognito window with no shared cookies/auth/storage that auto-closes when done. Stop now correctly cancels in-flight subagents along with the parent.

## 0.3.2

### Patch Changes

- 402b8d0: Add Attio as a built-in MCP connector (new "CRM" category) with OAuth, all 37 tools, and light/dark icons. Also fixes MCP reliability:

  - OAuth flow now sends a `state` parameter, required by strict providers like Attio (previously failed with "Authorization page could not be loaded").
  - Connected MCP servers are no longer torn down and reconnected on every home.html load — this eliminated a multi-second window where the agent saw zero MCP tools.
  - An active chat conversation now rebinds to the latest transport when MCP tools finish loading, so newly connected tools become available without a refresh.
  - Settings → Connectors left panel border now spans the full height.

## 0.3.1

### Patch Changes

- b5717e9: Fix three small chat issues:

  - Completion check no longer runs while a tool call is paused on human approval. The drafted text at that point is mid-narration ("I'll now run X to do Y") and isn't a final response — the gate now waits for the next iteration after approval, when the tool actually has output.
  - Long tool error logs collapse to ~10 visual lines with an inline expand toggle. Single-line errors that wrapped to dozens of visual lines now collapse correctly (the previous clamp only counted `\n`-delimited lines). Applied to executeCode/executeOnPage/executePython error output, the skill tool's error block, and the top-level chat error banner.
  - "Always allow on <site>" now reliably persists before the agent resumes. The previous implementation fired the storage write and the approval synchronously, so the next tool call's `needsApproval` check could race the write and re-prompt — most reproducible on home.html with back-to-back executeOnPage calls.

## 0.3.0

### Minor Changes

- 2604829: Agent: a separate skeptical evaluator now reviews each drafted final response before it reaches you, and asks the agent to revise if the response is incomplete or unsupported by what was actually observed. Mid-loop refinements show as a compact "Refining answer" pill; unresolved concerns surface as a soft warning. Choose a cheaper or faster evaluator model in Settings → General, or leave it on the default. Chat exports and the per-message Copy button now include the rejection block as part of the audit trail.

### Patch Changes

- 2604829: Agent reliability fixes:

  - Tab handles now persist across mid-stream conversation switches, so in-flight tool calls in the previous chat don't lose the tab they were targeting.
  - Stranded tool calls left over from interrupted streams heal cleanly on edit/retry/regenerate instead of breaking the conversation on resume.
  - Approving a tool call while other tools are still running in the same step no longer drops the auto-resume — the agent now picks up the approved call once the rest of the step completes.
  - Editing a user message in chat-db now logs a warning when the target id can't be found, surfacing the historical "stale tail after edit" failure mode at first repro instead of silently months later.
  - The completion-check evaluator now pins to its transport instance, so multiple concurrent agent windows can't drift across each other's models mid-stream.
  - Evaluator-error fallback messages no longer expose internal error details to the chat or markdown export; detailed errors stay in the developer console.

## 0.2.2

### Patch Changes

- 98f6004: Agent: tab arguments on browser tools are now explicit (`tab: "t1"`) instead of relying on an implicit "active tab". Fixes the "Always allow on this domain" approval button not appearing when the agent acted from the home tab. Conversation tab handles persist across service worker restarts. (#39)

## 0.2.1

- Fixes for rail layout mount and agent-transport compound keys (#24).

## 0.2.0

- Message queueing while the agent is streaming.
- Working-folder viewers, resizable side panel, and OPFS uploads (#21).
- Per-conversation file uploads to OPFS workspace (#18).
- Provider catalog cache invalidation on storage change.

## 0.1.1

- Initial public preview.

> Releases prior to changesets adoption are summarized from the GitHub
> release notes. Future entries will be authored from `.changeset/*.md`
> files attached to each PR.
