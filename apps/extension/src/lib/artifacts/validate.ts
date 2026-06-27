import type { ArtifactManifest, ToolMode } from "./manifest";
import { CDN_REGISTRY } from "./cdn-registry";

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
// Network allowlist entries: an exact host (2+ labels, e.g. `api.example.com`),
// or a `*.suffix` wildcard matching any subdomain. The wildcard suffix may be a
// single label (`*.com`) or multi-label (`*.example.com`).
const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const NETWORK_HOST_RE = new RegExp(
  `^(?:\\*\\.${LABEL}(\\.${LABEL})*|${LABEL}(\\.${LABEL})+)$`,
  "i",
);
const TOOL_RE = /^(?:mcp\.[a-z0-9_-]+\.[a-z0-9_-]+|(?:browser|system)\.[a-z0-9_-]+)$/;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateManifest(m: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof m !== "object" || m === null) {
    return { ok: false, errors: ["manifest must be an object"], warnings };
  }
  const x = m as Partial<ArtifactManifest>;

  if (x.v !== 1) errors.push("v must equal 1");
  if (typeof x.id !== "string" || !ID_RE.test(x.id)) errors.push("id must match /^[a-z][a-z0-9-]{1,63}$/");
  if (typeof x.title !== "string" || x.title.length < 1 || x.title.length > 80) errors.push("title must be 1-80 chars");
  // `icon` is optional at the validator layer for backward compat with
  // artifacts saved before icons were introduced; the create_artifact tool
  // requires it for NEW artifacts. When present, it must be a short non-empty
  // string (a single emoji grapheme is typically 1–8 chars; cap at 32 to leave
  // room for ZWJ sequences without permitting arbitrary text).
  if (x.icon !== undefined && (typeof x.icon !== "string" || x.icon.length < 1 || x.icon.length > 32)) {
    errors.push("icon must be 1-32 chars (a single emoji)");
  }
  if (x.description !== undefined && (typeof x.description !== "string" || x.description.length > 500)) errors.push("description must be 0-500 chars");

  if (!Array.isArray(x.tools)) {
    errors.push("tools must be an array");
  } else {
    for (const [i, t] of x.tools.entries()) {
      if (!t || typeof t !== "object") { errors.push(`tools[${i}] must be an object`); continue; }
      if (typeof t.name !== "string" || !TOOL_RE.test(t.name)) errors.push(`tools[${i}].name must match mcp.<server>.<tool> | browser.<tool> | system.<tool>`);
      if (t.mode !== "read" && t.mode !== "write") errors.push(`tools[${i}].mode must be 'read' or 'write'`);
      const inferred = classifyMode(t.name);
      if (inferred && inferred !== t.mode) {
        warnings.push(`tools[${i}] (${t.name}): heuristic suggests mode='${inferred}', got '${t.mode}'`);
      }
    }
  }

  if (x.cdns !== undefined) {
    if (!Array.isArray(x.cdns)) errors.push("cdns must be an array");
    else for (const c of x.cdns) {
      if (typeof c !== "string" || !CDN_REGISTRY[c]) errors.push(`cdns: unknown entry '${c}'`);
    }
  }

  if (x.network !== undefined) {
    if (!Array.isArray(x.network)) errors.push("network must be an array");
    else for (const h of x.network) {
      if (typeof h !== "string" || !NETWORK_HOST_RE.test(h)) errors.push(`network: invalid hostname '${h}'`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function classifyMode(toolName: string): ToolMode | null {
  const last = toolName.split(".").pop() ?? "";
  if (/^(search|list|get|read|fetch|view)/.test(last)) return "read";
  if (/^(create|update|delete|set|put|post|patch|write|remove|add|cancel|close|complete|send)/.test(last)) return "write";
  return null;
}

function canonicalValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj).sort().map((k) => [k, canonicalValue(obj[k])]),
    );
  }
  return v;
}

/**
 * Produce a canonical (key-sorted, deterministic) JSON form so the manifest
 * sha is stable across key reordering. Arrays are NOT sorted (order is
 * meaningful for tools[]).
 */
export function canonicalizeManifest(m: ArtifactManifest): string {
  const securitySubset = {
    v: m.v,
    id: m.id,
    tools: m.tools,
    cdns: m.cdns,
    network: m.network,
  };
  return JSON.stringify(canonicalValue(securitySubset));
}

export async function manifestVersion(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
