/**
 * models.dev catalog loader for the docs site.
 *
 * Mirrors the pattern the extension uses (live fetch + cache), adapted
 * for Next.js: a single `fetch()` with ISR that revalidates every hour.
 * If the network call fails (offline build, models.dev down, etc.) we
 * return an empty catalog and the page renders with no providers rather
 * than failing the build.
 */

const SOURCE_URL = "https://models.dev/api.json";
const REVALIDATE_SECONDS = 60 * 60; // 1 hour

// Module-level memo: dedupes the fetch across the many calls that
// happen in a single Next build (one per provider in
// generateStaticParams + one per provider page). The full models.dev
// payload is ~2.7MB, which exceeds Next's data cache limit, so without
// this we'd refetch on every call.
let inflight: Promise<Catalog> | null = null;

export interface ModelEntry {
  id: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  open_weights?: boolean;
  release_date?: string;
  knowledge?: string;
  limit?: { context: number; output: number; input?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: { input?: string[]; output?: string[] };
  status?: "alpha" | "beta" | "deprecated";
}

export interface ProviderEntry {
  id: string;
  name: string;
  api?: string;
  doc?: string;
  npm?: string;
  env?: string[];
  models: Record<string, ModelEntry>;
}

export type Catalog = Record<string, ProviderEntry>;

export async function getCatalog(): Promise<Catalog> {
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const res = await fetch(SOURCE_URL, {
        next: { revalidate: REVALIDATE_SECONDS },
      });
      if (!res.ok) {
        // Don't pin an empty catalog forever — let the next caller retry.
        inflight = null;
        return {};
      }
      return (await res.json()) as Catalog;
    } catch {
      inflight = null;
      return {};
    }
  })();
  inflight = promise;
  return promise;
}

export async function getProvider(id: string): Promise<ProviderEntry | null> {
  const catalog = await getCatalog();
  return catalog[id] ?? null;
}

export function sortedProviders(catalog: Catalog): ProviderEntry[] {
  return Object.values(catalog).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function modelCount(provider: ProviderEntry): number {
  return Object.keys(provider.models).length;
}

export function totalModelCount(catalog: Catalog): number {
  return Object.values(catalog).reduce((acc, p) => acc + modelCount(p), 0);
}

export function sortedModels(provider: ProviderEntry): ModelEntry[] {
  return Object.values(provider.models).sort((a, b) => {
    // newest first when release dates are present, otherwise alpha by id
    const aDate = a.release_date ?? "";
    const bDate = b.release_date ?? "";
    if (aDate && bDate && aDate !== bDate) return bDate.localeCompare(aDate);
    return a.id.localeCompare(b.id);
  });
}

/** Group providers by their npm SDK family for the listing page. */
export function groupByAdapter(providers: ProviderEntry[]): Record<string, ProviderEntry[]> {
  const groups: Record<string, ProviderEntry[]> = {};
  for (const p of providers) {
    const key = p.npm ?? "other";
    (groups[key] ??= []).push(p);
  }
  return groups;
}

/** Friendly label for a models.dev `npm` SDK identifier. */
export function adapterLabel(npm: string): string {
  switch (npm) {
    case "@ai-sdk/anthropic":
      return "Anthropic";
    case "@ai-sdk/openai":
      return "OpenAI";
    case "@ai-sdk/google":
      return "Google";
    case "@ai-sdk/xai":
      return "xAI";
    case "@ai-sdk/mistral":
      return "Mistral";
    case "@ai-sdk/openai-compatible":
    case "@openrouter/ai-sdk-provider":
      return "OpenAI-Compatible";
    case "other":
      return "Other";
    default:
      return npm;
  }
}
