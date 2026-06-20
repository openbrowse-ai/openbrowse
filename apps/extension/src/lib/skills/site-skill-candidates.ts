import { urlToDomain } from "./site-skill-catalog";

export interface SiteSkillCandidate {
  domain: string;
  /** Full inline executeOnPage code body. */
  code: string;
  /** Stringified observed result (truncated for prompt budget). */
  observedResult: string;
}

/** Min code length to treat an inline executeOnPage as reusable (skip probes). */
const MIN_CODE_CHARS = 80;
const RESULT_TRUNCATE = 2000;

interface ExtractArgs {
  messages: { role: string; parts?: unknown[] }[];
  /** Domains present in the open-tabs site-skill catalog this turn. */
  catalogDomains: string[];
  /** The active tab URL at gate time (used to attribute the candidate domain). */
  activeUrl?: string;
}

function asExecutePart(
  p: unknown,
): { input?: unknown; output?: unknown; state?: string } | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  const isExec =
    type === "tool-executeOnPage" ||
    (type === "tool-call" && o.toolName === "executeOnPage") ||
    (type === "dynamic-tool" && o.toolName === "executeOnPage");
  if (!isExec) return null;
  return {
    input: o.input,
    output: o.output,
    state: typeof o.state === "string" ? o.state : undefined,
  };
}

/**
 * Extract reusable site-skill candidates from a turn's assistant messages.
 *
 * Pure/deterministic. Only fires when the active tab's domain has an entry in
 * the open-tabs site-skill catalog. Captures inline `executeOnPage` calls with
 * non-trivial code that produced a non-empty, non-errored result. Skips:
 *  - `scriptRef` runs (already-saved scripts — never re-author them),
 *  - trivial probes (code shorter than MIN_CODE_CHARS),
 *  - empty/errored results (failed derivations).
 */
export function extractSiteSkillCandidates(
  args: ExtractArgs,
): SiteSkillCandidate[] {
  const catalog = new Set(args.catalogDomains);
  const activeDomain = args.activeUrl ? urlToDomain(args.activeUrl) : null;
  if (!activeDomain || !catalog.has(activeDomain)) return [];

  const out: SiteSkillCandidate[] = [];
  for (const m of args.messages) {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    for (const part of m.parts) {
      const tp = asExecutePart(part);
      if (!tp) continue;
      if (tp.state === "output-error") continue;
      const input = (tp.input ?? {}) as Record<string, unknown>;
      // scriptRef runs are already-saved scripts — never re-author them.
      if (input.scriptRef) continue;
      const code = typeof input.code === "string" ? input.code : "";
      if (code.length < MIN_CODE_CHARS) continue;
      // Skip empty results (failed derivations).
      const output = tp.output;
      if (output == null) continue;
      if (Array.isArray(output) && output.length === 0) continue;
      let observedResult: string;
      try {
        observedResult = JSON.stringify(output);
      } catch {
        observedResult = String(output);
      }
      if (!observedResult || observedResult === "{}" || observedResult === "[]")
        continue;
      out.push({
        domain: activeDomain,
        code,
        observedResult: observedResult.slice(0, RESULT_TRUNCATE),
      });
    }
  }
  return out;
}

/**
 * Decide whether this turn had "notable friction" on the active catalog domain
 * worth curating a NOTE for, even when no reusable script candidate emerged.
 *
 * The background curator can record durable site notes (navigation quirks,
 * where content lives, overlay/consent gotchas) — these are most valuable
 * exactly on turns that produced no script (e.g. a scriptRef replay that hit a
 * `navigate` timeout). Without this signal the curator would never run on such
 * turns.
 *
 * Pure/deterministic. Returns the active catalog domain when the turn contains
 * at least one tool call that errored, timed out, or was denied; otherwise
 * null. Scoped to the active domain (same attribution rule as candidates) so we
 * don't author notes for domains the turn only incidentally touched.
 */
export function detectNotableActivityDomain(args: {
  messages: { role: string; parts?: unknown[] }[];
  catalogDomains: string[];
  activeUrl?: string;
}): string | null {
  const catalog = new Set(args.catalogDomains);
  const activeDomain = args.activeUrl ? urlToDomain(args.activeUrl) : null;
  if (!activeDomain || !catalog.has(activeDomain)) return null;

  for (const m of args.messages) {
    if (!Array.isArray(m.parts)) continue;
    for (const part of m.parts) {
      if (!part || typeof part !== "object") continue;
      const o = part as Record<string, unknown>;
      const type = typeof o.type === "string" ? o.type : "";
      // Only consider tool-result parts (AI-SDK UIMessage tool parts).
      if (!type.startsWith("tool-") && type !== "dynamic-tool") continue;
      const state = typeof o.state === "string" ? o.state : "";
      if (state === "output-error") return activeDomain;
      // Some tools surface failure in the output payload rather than the
      // part state (e.g. `{ error: "Tab load timed out" }`).
      const output = o.output;
      if (output && typeof output === "object") {
        const oo = output as Record<string, unknown>;
        if (typeof oo.error === "string" && oo.error.length > 0)
          return activeDomain;
      }
    }
  }
  return null;
}
