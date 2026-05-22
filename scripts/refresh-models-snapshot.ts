/**
 * Fetches https://models.dev/api.json, validates it against the
 * canonical schema, and writes a stable JSON snapshot used as the
 * bundled fallback inside the extension.
 *
 * Run via: pnpm refresh:models
 *
 * In CI, a nightly workflow re-runs this and opens a PR if the
 * snapshot changes (see .github/workflows/refresh-models.yml).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelsDevCatalogSchema } from "../apps/extension/src/registry/models-dev/types.ts";

const SOURCE = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT = resolve(
  __dirname,
  "../apps/extension/src/registry/models-dev/snapshot.json",
);

async function main(): Promise<void> {
  console.log(`[refresh-models] fetching ${SOURCE}…`);
  const res = await fetch(SOURCE);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as unknown;

  const parsed = ModelsDevCatalogSchema.parse(raw);
  const providerCount = Object.keys(parsed).length;
  const modelCount = Object.values(parsed).reduce(
    (acc, p) => acc + Object.keys(p.models).length,
    0,
  );

  // Stable JSON: sort keys at every depth so diffs are minimal.
  const sorted = stableSort(parsed);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(sorted, null, 2) + "\n", "utf8");

  console.log(
    `[refresh-models] wrote ${OUTPUT} (${providerCount} providers, ${modelCount} models)`,
  );
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stableSort(v)]),
    );
  }
  return value;
}

main().catch((err) => {
  console.error("[refresh-models] failed:", err);
  process.exit(1);
});
