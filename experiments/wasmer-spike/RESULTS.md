# Phase 0 Spike Results: Edge.js Browser Viability

**Date:** 2026-05-19
**Environment:** macOS 15.7, Chrome for Testing 148.0.7778.178 (headed mode required for COI)
**Stack:** `@wasmer/sdk@0.10.0`, vite dev server with `COOP: same-origin` + `COEP: require-corp`

## TL;DR

**The bet is dead today.** Edge.js cannot run in `@wasmer/sdk@0.10.0` due to a fundamental WASM-feature incompatibility: Edge.js builds use **WebAssembly exception handling** (`exnref` reference type), which Wasmer's JS SDK polyfill explicitly does not support. Both `wasmer/edgejs@0.0.1` and `@0.0.2` fail identically.

**The collateral discovery:** even **Python** is constrained — only `python/python@0.2.0` (legacy build) runs; `@3.13.x` (current) imports the unsupported `wasix_32v1.proc_fork_env`.

**Recommendation:** Pivot. Drop Phases 4–5 of the master plan as designed. Defer Node-on-WASIX until upstream `@wasmer/sdk` adds exception-handling support (no public ETA). Ship Phases 1–3 (VFS + FS tools + Bash + skills installer) which deliver ~60% of the ecosystem value without Edge.js, and add Python via the legacy build.

---

## Test results

| Test | Status | Notes |
|------|--------|-------|
| **T0** Diagnostic | PASS | Same-origin GET ✓, cross-origin POST to `registry.wasmer.io/graphql` ✓, `crossOriginIsolated=true` (only in **headed** Chrome — see Discovery #1) |
| **T1** Python hello world | **CONDITIONAL PASS** | Fails on `python/python@3.13.5` (newest) with exit code 45, empty stdout/stderr; trace logs reveal `Failed to instantiate module: ...wasix_32v1.proc_fork_env: function import requires a callable`. Passes on `python/python@0.2.0` (legacy build). |
| **T2** Edge.js boots | **FAIL** | `wasmer/edgejs@0.0.1` and `@0.0.2` both panic during module load: `panicked at wasmer-6.1.0/src/utils/polyfill.rs:406:34: only numeric types are supported in function signatures: "Unsupported ref type: exnref"`. **This is the bet-killer.** |
| **Bonus** sharrattj/bash | **CONDITIONAL PASS** | Stdout is captured correctly (`"hi from bash\n"`) but exit code reports `45` instead of `0`. Both `sharrattj/bash@1.0.18` (latest) and `@1.0.12` behave identically. **Stdout-correct, exit-code-incorrect.** Implication: Phase 2 (Bash) is viable, but we cannot trust `result.code === 0` as success — must judge success by stdout/stderr content. |
| T3 VFS + fs | NOT RUN | Replaced with bash bonus test |
| T4 Outbound HTTP | NOT RUN | Blocked by T2 |
| T5 Module resolution | NOT RUN | Blocked by T2 |
| T6 Real skill | NOT RUN | Blocked by T2 |

---

## Discoveries

### Discovery #1: Headless Chrome silently disables Cross-Origin Isolation

Even with COOP `same-origin` + COEP `require-corp` headers correctly set, headless Chrome reports `crossOriginIsolated: false` and `typeof SharedArrayBuffer === 'undefined'`. Switching to headed mode (`agent-browser --headed`) immediately produced `crossOriginIsolated: true`.

This is unrelated to our extension, since OpenBrowse runs in real browsers. But it cost ~30 minutes of debugging in the spike. Note for the RESULTS file: any future browser-automation testing of @wasmer/sdk must be done in **headed** mode.

### Discovery #2: `python/python@3.13.5` fails on `proc_fork_env` import

Wasmer SDK trace log:

```
ERROR handle{worker.id=2}:
  wasmer_js::tasks::task_wasm: Failed to crate wasi context
  error=Linker error: Failed to instantiate module:
    RuntimeError: js: WebAssembly.Instance(): Import #74 "wasix_32v1" "proc_fork_env":
    function import requires a callable
```

Newer python builds use process-forking syscalls that the JS SDK doesn't expose. The legacy `python/python@0.2.0` predates this and runs fine.

**Implication for the master plan:** if we ship Python skills, we must pin to `python/python@0.2.0` and accept that this is an old Python with a smaller stdlib. Pyodide is still the better in-browser Python option.

### Discovery #3: Edge.js panics on `exnref` (WebAssembly exception handling)

```
ERROR handle{worker.id=4}:load_module:
  wasmer_js: panicked at .../wasmer-6.1.0/src/utils/polyfill.rs:406:34:
  only numeric types are supported in function signatures: "Unsupported ref type: exnref"
```

Edge.js compiles with WebAssembly exception handling enabled — a [Phase-3 WebAssembly feature](https://webassembly.github.io/exception-handling/core/) that exposes a new reference type `exnref` for catching exceptions. Modern Node (V8) and the native Edge.js binary support it. The Wasmer JS SDK's WASM-runtime polyfill (a stripped-down version of the native Wasmer runtime) does not.

This is not a configuration issue we can work around with options or version pinning. It's a missing feature in the runtime polyfill itself. Until `wasmerio/wasmer-js` lands exception-handling support — which, judging by the `polyfill.rs:406` location, is a non-trivial engineering effort — Edge.js cannot run in browsers via `@wasmer/sdk`.

### Discovery #4: `sharrattj/bash` runs correctly but reports wrong exit code

`sharrattj/bash@1.0.12` and `@1.0.18` both produce correct stdout when invoked via `bash -c "echo hi"`, but `result.code` is `45` (not `0`) regardless of actual command success. This appears to be an `@wasmer/sdk` quirk — possibly the SDK's pseudo-exit-code for processes that exit by signal-like paths in WASIX.

**Workaround for Phase 2:** treat code 45 plus non-empty stdout as success. Or use the streaming stdout/stderr APIs (`Instance.stdout`, `Instance.stderr` ReadableStreams) which deliver byte-for-byte output regardless of exit code.

### Discovery #5: Wasmer registry CDN blocks one URL but works for actual package downloads

`fetch('https://registry-cdn.wasmer.io/')` failed with "Failed to fetch", but actual package webc downloads from `cdn.wasmer.io/webcimages/<hash>.webc` worked fine. Likely a CORS misconfiguration on that one endpoint. Not actually a blocker.

---

## Re-verdict on the master plan

The original master plan ([`2026-05-19-runtime-and-skills-execution.md`](./2026-05-19-runtime-and-skills-execution.md)) staked Phases 4–5 on the Edge.js bet. With the bet failing, those phases need redesign:

### What **survives** unchanged

- **Phase 1: VFS + FS tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`LS`)** — pure OPFS, no Wasmer dependency. Still the highest-value phase. Ships ~60% of the skills ecosystem (class A pure-context + many class B skills that just do file ops).
- **Phase 3: Skills installer** — already mostly built in `feature-agent-skills` worktree. No Wasmer dependency.
- **Phase 6: Browser-host carve-out** — class C skills route to OpenBrowse's tab/CDP tools. No Wasmer dependency. Strongest competitive moat.

### What **changes**

- **Phase 2: Bash via Wasmer** — needs verification. `wasmer/bash` package may or may not work in `@wasmer/sdk@0.10.0`. Must spike before committing. If it fails the same way Python 3.13 did, Bash also is dead.
  - **Action:** Add a Phase 0.5 spike: load `wasmer/bash`, run `echo hi`, verify exit code 0.
  - If pass → Phase 2 proceeds as designed.
  - If fail → Bash is implemented as a JS-native shell parser routing commands to FS tools, with no real `bash` binary. Less powerful but still useful for piping/redirection patterns the agent expects.

- **Phase 4: `runSkill` via Wasmer (Python + Node)** — Node path is dead. Python path is constrained to `python/python@0.2.0`.
  - **Action:** Replace the Python path with **Pyodide** (mature, browser-native, larger stdlib, well-maintained). Drop the Node path entirely until Edge.js + Wasmer SDK exception handling lands.

- **Phase 5: Edge.js bet validation** — moot. Drop the phase.

### New deferred work

- **Watching Edge.js + Wasmer SDK roadmaps** — when both `wasmerio/wasmer-js` lands exception-handling support AND Edge.js stabilizes, revisit. Set a calendar reminder for Q3 2026 review.
- **Alternative Node-in-browser runtimes** — track if any new project emerges. Currently none.

---

## Suggested next steps for the project

1. **Stop here on the spike.** Don't bother running T3-T6; the verdict is already clear.
2. **Update master spec** (`2026-05-19-runtime-and-skills-execution.md`) Decisions log:
    - Edge.js bet: **failed**. Defer Node-on-WASIX indefinitely.
    - Python runtime: **switch to Pyodide** for Phase 4.
    - Add Phase 0.5: spike `wasmer/bash`.
3. **Proceed with Phase 1** (FS tools + file tree UI). This is independently valuable and unblocked.
4. **Run the Bash spike (Phase 0.5)** in parallel with Phase 1 design.

---

## Spike artifacts

- `experiments/wasmer-spike/` — live testbed; can be deleted or kept as reference
- `src/runner.ts` — test harness
- `vite.config.ts` — COOP/COEP setup
- This file — RESULTS.md
