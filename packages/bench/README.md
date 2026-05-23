# @openbrowse/bench

Evaluation harness for the OpenBrowse agent. Runs the agent **headlessly**
(or, by default, headed) outside the Chrome extension via Playwright, so we
can systematically benchmark different `Model × System Prompt × Tool Set`
configurations.

It also supports running against **Kernel**'s cloud browser infrastructure for massively parallel, stealth-enabled testing.

This package provides the evaluation tooling for the OpenBrowse agent. It ships:

- A public task suite (smoke tests + WebBench subset).
- The runner, drivers, and judges that produce reproducible numbers.
- A CLI for manual invocation and running sweeps.

## Quick start

```bash
# 1. Copy the env template and fill in the keys for the providers you want
cp packages/bench/.env.example packages/bench/.env
$EDITOR packages/bench/.env

# 2. Install + run a smoke task against the default model
pnpm install
pnpm --filter @openbrowse/bench bench --task example-com-heading

# 3. Run a concurrent sweep using Kernel
pnpm --filter @openbrowse/bench bench --suite webbench-mini --driver kernel
```

The first run will download Playwright's Chromium binary if it isn't cached.

## Resuming an interrupted run

If a suite crashes, times out, or you kill it manually, you can resume it. The runner will automatically skip tasks that already have a trial JSON in the directory. 

By default, any task that encountered an error (e.g., an infrastructure timeout or an agent crash) will be deleted and re-attempted. Pass `--keep-errors` if you want to skip errored tasks instead.

```bash
# Example: Resume a specific partial run
npx tsx src/cli.ts \
  --resume .bench/runs/2026-05-23T00-56-17-gemini-3-pro-preview-webbench-mini \
  --suite webbench-mini \
  --model gemini-3-pro-preview \
  --driver kernel \
  --concurrency 10
```

*Note: The CLI aggregates all trials (both old and newly-run) into the final `summary.json` table.*

### Where to put your API keys

The CLI auto-loads `.env` files (via `dotenv`) from these paths, in order:

| Priority | Path | When to use |
|---|---|---|
| Highest | `packages/bench/.env` | Default. Per-package keys; doesn't leak to other workspace packages. |
| Middle | `<workspace-root>/.env` | Share keys across `apps/extension` and other future consumers. |
| Lowest | shell env (`export ANTHROPIC_API_KEY=...`) | CI, one-off invocations. |

`.env*` is gitignored at the repo root so any of these paths is safe to use.
The `llm-judge` evaluator uses Gemini 3.5 Flash, so
`GOOGLE_GENERATIVE_AI_API_KEY` is required for any task that uses it.

To use the Kernel driver for parallel cloud execution, provide `KERNEL_API_KEY`.

## Architecture

```
packages/bench/
├── src/
│   ├── runner.ts                  Single-trial runner. Launches Chromium,
│   │                              builds a ToolContext, runs the agent loop,
│   │                              calls the judge, returns a TrialResult.
│   ├── worker-pool.ts             Multi-trial parallel executor.
│   ├── store.ts                   JSON persistence for trials and summaries.
│   ├── env.ts                     Environment variable loader.
│   ├── paths.ts                   Filesystem path resolution and run structure.
│   ├── video.ts                   FFmpeg conversion (webm -> mp4).
│   ├── cli.ts                     Manual CLI entrypoint.
│   ├── drivers/
│   │   ├── playwright-driver.ts   BrowserDriver impl: wraps a Playwright
│   │   │                              Page + native CDP session. Speaks the
│   │   │                              same CDP commands the extension does.
│   │   ├── kernel-driver.ts       BrowserDriver impl: wraps @onkernel/sdk
│   │   │                              for fast, concurrent cloud browsers.
│   │   └── visualizing-driver.ts  Wrapper driver that injects click/type overlays.
│   ├── judges/
│   │   ├── exact-match.ts         For extraction tasks with deterministic answers.
│   │   ├── url-match.ts           For navigation tasks (regex match on final URL).
│   │   ├── llm-judge.ts           For open-ended tasks (Gemini 3.5 Flash).
│   │   └── index.ts               Dispatcher.
│   ├── tasks/
│   │   ├── types.ts               BenchmarkTask, EvaluatorSpec types.
│   │   ├── smoke.ts               Tiny deterministic suite for harness testing.
│   │   └── webbench/              Loader for the WebBench dataset.
│   └── agent/
│       ├── build-agent.ts         Constructs the bench-flavored ToolLoopAgent.
│       ├── headless-chat.ts       Consumes the Vercel AI SDK stream headlessly.
│       └── run-compaction.ts      Implements token compaction without UI state.
└── scripts/
    ├── import-webbench.ts         Updates the cached WebBench CSV.
    ├── scan-overlays.ts           Verifies overlay renders via CV/pixel-matching.
    ├── verify-overlays.ts         Manual visual test for the VisualizingDriver.
    └── driver-smoke.ts            Quick sanity check for Playwright automation.
```

### Why "headed by default"?

Per the eval-harness spec's resolved decisions, the screenshot tool relies
on real rendered pixels — headless Chromium doesn't produce them reliably on
many sites. The default is headed execution; pass `--headless` if you don't care
about screenshot output (e.g. an extraction-only matrix).

### Why `experimental_context` for tool plumbing?

The Vercel AI SDK threads a per-call `experimental_context` value down to
every tool's `execute(input, options)`. We pack a `ToolContext`
(`{ driver, session }`) into that channel. Tools read `ctx.driver` instead
of importing `chrome.*` APIs. The same pattern works in the production
extension (where `driver` is an `ExtensionDriver`) and in this harness
(where it's a `PlaywrightDriver`).

## WebBench Task Selection

The OSS harness defaults to testing against a subset of [WebBench](https://webbench.ai/), the industry standard dataset containing 5,750 tasks across 452 websites.

Because the full dataset requires authentication (creating accounts, managing saved state) which complicates CI pipelines, the OSS runner provides a hand-curated, **READ-only** subset of tasks.

WRITE tasks (logins, form fills, file uploads) are currently out of scope for the public harness because they require persistent authenticated profiles, though the runner architecture (`requiresAuth`) can support them if extended.

## Adding a task

1. Append to `src/tasks/smoke.ts` (for smoke tests) or create a new file under
   `src/tasks/` for a real suite.
2. Each task is a `BenchmarkTask`:
   ```ts
   {
     id: "my-task",
     instruction: "What's the user-facing question?",
     startUrl: "https://example.com",
     category: "extraction",
     source: "custom",
     evaluator: { kind: "exact-match", expected: "..." },
   }
   ```
3. The runner pre-navigates to `startUrl` so the agent doesn't have to spend
   its first turn opening the page.

## Adding a model

The CLI dispatches on the model id prefix:

| prefix | provider |
|---|---|
| `claude-` | `@ai-sdk/anthropic` |
| `gpt-`, `o`* | `@ai-sdk/openai` |
| `gemini-` | `@ai-sdk/google` |

For other providers, edit `resolveModel()` in `src/cli.ts`.

## Future work

- `bench-baseline.ts` — single-command hero-score script for the root README.
- Wire CI to run a smoke subset on PRs (deferred per spec — manual only for
  v1).
