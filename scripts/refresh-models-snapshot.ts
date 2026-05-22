/**
 * Fetches https://models.dev/api.json, validates it against the
 * canonical schema, and writes a stable JSON snapshot used as the
 * bundled fallback inside the extension.
 *
 * Also refreshes provider logos from https://models.dev/logos/{id}.svg
 * for each provider id we ship icons for. Skips logos that match the
 * models.dev default fallback (so we don't overwrite a real local
 * icon with a generic one).
 *
 * Run via: pnpm refresh:models
 *
 * In CI, a nightly workflow re-runs this and opens a PR if anything
 * changed (see .github/workflows/refresh-models.yml).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelsDevCatalogSchema } from "../apps/extension/src/registry/models-dev/types.ts";

const SOURCE = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";
const LOGOS_BASE = process.env.MODELS_DEV_LOGOS_BASE ?? "https://models.dev/logos";

/**
 * Provider npm packages we ship SDKs for. Keep in sync with
 * BUNDLED_PROVIDERS keys in
 * apps/extension/src/registry/models-dev/bundled-sdks.ts.
 *
 * The refresh script enumerates the snapshot to find every provider
 * whose `npm` is in this set and fetches its logo from
 * models.dev/logos/{id}.svg. The default-fallback hash check below
 * prevents bundling 100 copies of models.dev's generic placeholder
 * for providers that don't have a real logo upstream.
 */
const SUPPORTED_NPMS = new Set<string>([
  "@ai-sdk/anthropic",
  "@ai-sdk/cerebras",
  "@ai-sdk/google",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/perplexity",
  "@ai-sdk/togetherai",
  "@ai-sdk/xai",
  "@ai-sdk/azure",
  "@ai-sdk/gateway",
  "@openrouter/ai-sdk-provider",
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SNAPSHOT_OUT = resolve(
  __dirname,
  "../apps/extension/src/registry/models-dev/snapshot.json",
);
const ICONS_DIR = resolve(
  __dirname,
  "../apps/extension/src/registry/providers/icons",
);

async function refreshSnapshot(): Promise<Record<string, { npm?: string }>> {
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

  const sorted = stableSort(parsed);

  mkdirSync(dirname(SNAPSHOT_OUT), { recursive: true });
  writeFileSync(SNAPSHOT_OUT, JSON.stringify(sorted, null, 2) + "\n", "utf8");

  console.log(
    `[refresh-models] wrote ${SNAPSHOT_OUT} (${providerCount} providers, ${modelCount} models)`,
  );

  return parsed as unknown as Record<string, { npm?: string }>;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchSvg(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    // Sanity check: must look like an SVG (rules out HTML error pages).
    const head = buf.subarray(0, 200).toString("utf8").trimStart();
    if (!head.startsWith("<svg") && !head.startsWith("<?xml")) return null;
    return buf;
  } catch {
    return null;
  }
}

async function refreshLogos(
  catalog: Record<string, { npm?: string }>,
): Promise<void> {
  // Fetch the default fallback once so we can detect when models.dev
  // returns it for a provider we asked about (don't overwrite a real
  // local icon with a generic placeholder).
  const fallback = await fetchSvg(`${LOGOS_BASE}/__nonexistent_${Date.now()}.svg`);
  const fallbackHash = fallback ? sha256(fallback) : null;
  if (!fallbackHash) {
    console.warn(
      "[refresh-models] could not establish models.dev default-logo hash; skipping logo refresh",
    );
    return;
  }

  mkdirSync(ICONS_DIR, { recursive: true });

  const surfacedIds = Object.entries(catalog)
    .filter(([, p]) => p.npm && SUPPORTED_NPMS.has(p.npm))
    .map(([id]) => id)
    .sort();

  let written = 0;
  let skippedDefault = 0;
  let skippedUnchanged = 0;
  let failed = 0;

  // Fetch in small parallel batches to avoid hammering models.dev.
  const BATCH = 8;
  for (let i = 0; i < surfacedIds.length; i += BATCH) {
    const batch = surfacedIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (id) => {
        const url = `${LOGOS_BASE}/${id}.svg`;
        const svg = await fetchSvg(url);
        if (!svg) {
          failed++;
          return;
        }
        if (sha256(svg) === fallbackHash) {
          skippedDefault++;
          return;
        }
        const out = resolve(ICONS_DIR, `${id}.svg`);
        const existing = existsSync(out) ? readFileSync(out) : null;
        if (existing && sha256(existing) === sha256(svg)) {
          skippedUnchanged++;
          return;
        }
        writeFileSync(out, svg);
        written++;
      }),
    );
  }

  console.log(
    `[refresh-models] logos: ${written} written, ${skippedUnchanged} unchanged, ${skippedDefault} no-real-logo, ${failed} failed (of ${surfacedIds.length} surfaced)`,
  );
}

async function main(): Promise<void> {
  const catalog = await refreshSnapshot();
  await refreshLogos(catalog);
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
