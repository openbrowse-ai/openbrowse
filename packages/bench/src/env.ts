/**
 * Load `.env` files from sensible locations so the bench harness can read
 * provider API keys without forcing the user to remember to `source` a file
 * before every run.
 *
 * Lookup order (first hit wins, but later files do NOT override earlier
 * ones — `dotenv` semantics):
 *
 *   1. `packages/bench/.env`             ← per-package, highest precedence
 *   2. workspace-root `.env`              ← shared across the monorepo
 *   3. process-level env vars             ← already in `process.env`
 *
 * Both files are gitignored via the repo's root `.gitignore` (`.env*`).
 *
 * Set keys in one of these files, e.g.:
 *
 *     ANTHROPIC_API_KEY=sk-ant-...
 *     OPENAI_API_KEY=sk-...
 *     GOOGLE_GENERATIVE_AI_API_KEY=AIza...   # required: judge uses Gemini
 *
 * The Vercel AI SDK providers (`@ai-sdk/anthropic`, etc.) read directly
 * from `process.env` so no further wiring is needed.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the bench package root, regardless of where the script is run from.
 *  This file lives at `<bench>/src/env.ts`, so go up one level. */
const PACKAGE_ROOT = resolve(__dirname, "..");

/**
 * Walk up from a starting directory looking for the workspace root marker
 * (`pnpm-workspace.yaml`). Returns null if not found.
 */
function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolve and load every relevant `.env` file. Idempotent. */
export function loadEnv(): void {
  const candidates: string[] = [];

  // Per-package .env wins for any conflicting keys.
  candidates.push(resolve(PACKAGE_ROOT, ".env"));

  // Workspace-root .env as a shared fallback.
  const wsRoot = findWorkspaceRoot(PACKAGE_ROOT);
  if (wsRoot) candidates.push(resolve(wsRoot, ".env"));

  for (const path of candidates) {
    if (existsSync(path)) {
      // override:false means earlier loads (and process.env) take precedence
      // over later ones, which matches the precedence order documented above.
      config({ path, override: false });
    }
  }
}
