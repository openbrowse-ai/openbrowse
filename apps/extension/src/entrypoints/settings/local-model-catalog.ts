import type { ModelDefinition } from "@/registry/providers/types";

/**
 * Grouping helpers that turn the flat prebuilt WebLLM model list (~139 entries,
 * mostly quantization variants of the same base model) into a browsable
 * catalog: family → base model → quant variants. Pure and dependency-free so
 * it's unit-testable.
 */

export interface QuantVariant {
  model: ModelDefinition;
  /** Normalized quant tag, e.g. "q4f16" ("" when the id carries none). */
  quant: string;
}

export interface BaseModel {
  /** Model id with the quant tag stripped, e.g. "Llama-3.2-3B-Instruct". */
  baseKey: string;
  /** Display name, e.g. "Llama 3.2 3B Instruct". */
  baseName: string;
  /** Coarse family bucket, e.g. "Llama". */
  family: string;
  /** Quant variants, recommended first. */
  variants: QuantVariant[];
  /** Union of capabilities across variants. */
  capabilities: ModelDefinition["capabilities"];
}

export interface FamilyGroup {
  family: string;
  bases: BaseModel[];
}

const QUANT_RE = /-(q\d+f\d+(?:_\d+)?|q0f\d+)$/i;

/** Split an mlc model id into its quant-less base and normalized quant tag. */
export function splitQuant(id: string): { base: string; quant: string } {
  const noMlc = id.replace(/-MLC$/i, "");
  const m = noMlc.match(QUANT_RE);
  if (m && m.index !== undefined) {
    return {
      base: noMlc.slice(0, m.index),
      quant: m[1].toLowerCase().replace(/_\d+$/, ""),
    };
  }
  return { base: noMlc, quant: "" };
}

/** Coarse family bucket = the leading dash-segment of the base id. */
export function familyOf(base: string): string {
  return base.split("-")[0] || base;
}

function baseDisplayName(base: string): string {
  return base.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

// Lower = preferred as the default variant: small + good quality first.
const QUANT_ORDER: Record<string, number> = {
  q4f16: 0,
  q4f32: 1,
  q3f16: 2,
  q0f16: 3,
  q0f32: 4,
};
function quantRank(quant: string): number {
  return QUANT_ORDER[quant] ?? 9;
}

/**
 * Group models into families → base models → variants. Families and bases are
 * ordered alphabetically; variants within a base are ordered by
 * recommended-first (see {@link quantRank}).
 */
export function groupLocalModels(models: ModelDefinition[]): FamilyGroup[] {
  const bases = new Map<string, BaseModel>();

  for (const model of models) {
    const { base, quant } = splitQuant(model.id);
    let entry = bases.get(base);
    if (!entry) {
      entry = {
        baseKey: base,
        baseName: baseDisplayName(base),
        family: familyOf(base),
        variants: [],
        capabilities: [],
      };
      bases.set(base, entry);
    }
    entry.variants.push({ model, quant });
    for (const cap of model.capabilities) {
      if (!entry.capabilities.includes(cap)) entry.capabilities.push(cap);
    }
  }

  for (const entry of bases.values()) {
    entry.variants.sort(
      (a, b) => quantRank(a.quant) - quantRank(b.quant) || a.quant.localeCompare(b.quant),
    );
  }

  const families = new Map<string, BaseModel[]>();
  for (const entry of bases.values()) {
    const list = families.get(entry.family) ?? [];
    list.push(entry);
    families.set(entry.family, list);
  }

  return [...families.entries()]
    .map(([family, list]) => ({
      family,
      bases: list.sort((a, b) => a.baseName.localeCompare(b.baseName)),
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** True when any variant of the base model is downloaded. */
export function isBaseDownloaded(
  base: BaseModel,
  downloadedModels: string[],
): boolean {
  return base.variants.some((v) => downloadedModels.includes(v.model.id));
}

/** Compact context-window label, e.g. 131072 -> "128K", 8192 -> "8K". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1024) {
    const k = tokens / 1024;
    return Number.isInteger(k) ? `${k}K` : `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}
