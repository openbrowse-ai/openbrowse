# Wasmer Spike (Phase 0)

Out-of-tree experiment validating whether `@wasmer/sdk@0.10.0` + Edge.js can power OpenBrowse skill execution in-browser.

**Verdict: bet failed.** See [RESULTS.md](./RESULTS.md) for the full findings, discoveries, and recommendation.

## Reproduce

```bash
pnpm install
pnpm exec vite --port 3335
```

Then open `http://localhost:3335` **in headed Chrome** (headless Chrome silently disables Cross-Origin Isolation, which `@wasmer/sdk` requires).

Click the test buttons in order: T0 → T1 → T2. T2 is the bet-killer.

## Files

- `index.html` — UI with one button per test
- `src/runner.ts` — test harness
- `vite.config.ts` — COOP/COEP setup
- `RESULTS.md` — findings + recommendation
