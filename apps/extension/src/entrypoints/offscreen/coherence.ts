/**
 * Pure gibberish detector for local-model output.
 *
 * Some WebLLM models load and report success but emit token salad on specific
 * GPUs/drivers — a known quantization + WebGPU failure mode (q4f16 builds are
 * frequent offenders, and the same model works fine on other machines). It is
 * therefore NOT something a sourced model catalog or a CI test can know: it has
 * to be observed at runtime on the actual device.
 *
 * This module is the scoring half of that check, kept pure and dependency-free
 * so it is fully unit-testable without a GPU, WebGPU, or model weights (same
 * rationale as `engine-lock.ts`). A runtime probe supplies the text; everything
 * here is string analysis.
 *
 * Design bias: **false negatives over false positives.** Calling a working
 * model broken is far worse than missing a broken one, and a genuinely tiny
 * model (0.5B) can produce weak-but-valid prose. So `garbled` is only returned
 * on strong structural evidence, and anything unclear is `inconclusive`.
 */

export type CoherenceVerdict = "ok" | "garbled" | "inconclusive";

export interface CoherenceSignals {
  /** U+FFFD replacement characters — near-certain broken-token output. */
  replacementChars: number;
  /**
   * Distinct writing-system *groups* present among letters. Grouped (not raw
   * script names) so legitimately multi-script languages don't look corrupt:
   * Japanese mixes Han + Hiragana + Katakana normally, so those count once.
   */
  scriptGroups: string[];
  /** Words mixing two space-separated writing systems (e.g. "May326ыві"). */
  intraWordScriptMixes: number;
  /** Long words fusing letters and digits (e.g. "whá958puaugeihan"). */
  letterDigitFusions: number;
  /** Improbably long unbroken words (e.g. "counterimitsurespremium"). */
  overlongWords: number;
  /** Highest number of immediate back-to-back repeats of any substring. */
  maxImmediateRepeat: number;
  /** Total word-like tokens. */
  wordCount: number;
  /** Share of words flagged malformed by any of the word-level signals. */
  malformedRatio: number;
}

export interface CoherenceResult {
  verdict: CoherenceVerdict;
  /** Why this verdict — surfaced in diagnostics and UI tooltips. */
  reasons: string[];
  signals: CoherenceSignals;
}

/**
 * Writing systems, mapped to the group used for counting. Scripts that share a
 * language (Japanese: Han/Kana) collapse into one group, as do the Indic
 * scripts, so a legitimate non-English answer isn't mistaken for salad.
 */
const SCRIPTS: ReadonlyArray<{ group: string; re: RegExp; spaced: boolean }> = [
  { group: "Latin", re: /[A-Za-z\u00C0-\u024F]/, spaced: true },
  { group: "Greek", re: /[\u0370-\u03FF]/, spaced: true },
  { group: "Cyrillic", re: /[\u0400-\u04FF]/, spaced: true },
  { group: "Hebrew", re: /[\u0590-\u05FF]/, spaced: true },
  { group: "Arabic", re: /[\u0600-\u06FF]/, spaced: true },
  { group: "Indic", re: /[\u0900-\u097F]/, spaced: true },
  { group: "Indic", re: /[\u0980-\u09FF]/, spaced: true },
  { group: "Indic", re: /[\u0B80-\u0BFF]/, spaced: true },
  // Unspaced scripts: word-internal mixing is normal, so they never count
  // toward `intraWordScriptMixes`.
  { group: "Thai", re: /[\u0E00-\u0E7F]/, spaced: false },
  { group: "Hangul", re: /[\u1100-\u11FF\uAC00-\uD7AF]/, spaced: false },
  { group: "CJK", re: /[\u3040-\u30FF]/, spaced: false },
  { group: "CJK", re: /[\u3400-\u4DBF\u4E00-\u9FFF]/, spaced: false },
];

/** Cap analysis cost on pathological output. */
const MAX_ANALYZED_CHARS = 4_000;

/**
 * Strip the parts of a reply that legitimately look like noise to the
 * word-level signals: fenced code blocks, inline code spans, URLs and long
 * bare hex/base64 blobs. Real agent output is full of these, and a false
 * "this model is broken" verdict is far more damaging than a missed one.
 * Only natural-language prose is scored.
 */
function extractProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(/\b[0-9a-f]{16,}\b/gi, " ")
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, " ");
}

/** A word longer than this is almost certainly run-together garbage. */
const OVERLONG_WORD = 24;

/**
 * Letter+digit fusions shorter than this are legitimate in technical prose
 * ("q4f16", "3D", "GPT4"), so only longer fusions count.
 */
const MIN_FUSION_LENGTH = 8;

function scriptGroupsOf(text: string, spacedOnly = false): string[] {
  const found = new Set<string>();
  for (const s of SCRIPTS) {
    if (spacedOnly && !s.spaced) continue;
    if (s.re.test(text)) found.add(s.group);
  }
  return [...found];
}

/**
 * Longest run of an immediately-repeated substring. Catches both spaced
 * degeneration ("the the the …") and unspaced token loops (the
 * `<|reserved_special_token_247|>` failure mode), which a whitespace split
 * would miss entirely.
 */
function maxImmediateRepeat(text: string): number {
  let max = 1;
  for (const m of text.matchAll(/(.{1,60}?)\1{2,}/gs)) {
    const unit = m[1];
    if (!unit.trim()) continue; // runs of pure whitespace are not degeneration
    max = Math.max(max, Math.floor(m[0].length / unit.length));
  }
  return max;
}

export function scoreCoherence(text: string): CoherenceResult {
  const raw = text.slice(0, MAX_ANALYZED_CHARS);
  // Word-level signals score prose only (see `extractProse`), but the
  // whole-sample signals — replacement chars, script mixing, degeneration —
  // are read from the raw text, since corruption there is meaningful wherever
  // it appears.
  const sample = extractProse(raw);
  const words = sample.match(/[\p{L}\p{N}_]+/gu) ?? [];

  let intraWordScriptMixes = 0;
  let letterDigitFusions = 0;
  let overlongWords = 0;
  const malformed = new Set<string>();

  for (const w of words) {
    let bad = false;
    if (scriptGroupsOf(w, true).length >= 2) {
      intraWordScriptMixes++;
      bad = true;
    }
    if (
      w.length >= MIN_FUSION_LENGTH &&
      /\p{L}/u.test(w) &&
      /\p{Nd}/u.test(w)
    ) {
      letterDigitFusions++;
      bad = true;
    }
    if (w.length >= OVERLONG_WORD) {
      overlongWords++;
      bad = true;
    }
    if (bad) malformed.add(w);
  }

  const signals: CoherenceSignals = {
    replacementChars: (raw.match(/\uFFFD/g) ?? []).length,
    scriptGroups: scriptGroupsOf(raw),
    intraWordScriptMixes,
    letterDigitFusions,
    overlongWords,
    maxImmediateRepeat: maxImmediateRepeat(raw),
    wordCount: words.length,
    malformedRatio: words.length === 0 ? 0 : malformed.size / words.length,
  };

  if (raw.trim().length === 0) {
    return { verdict: "inconclusive", reasons: ["no output"], signals };
  }

  // Strong evidence of corruption. Any single one is decisive.
  const reasons: string[] = [];
  if (signals.replacementChars >= 2) {
    reasons.push(`${signals.replacementChars} replacement characters`);
  }
  if (signals.scriptGroups.length >= 3) {
    reasons.push(`mixes ${signals.scriptGroups.length} writing systems (${signals.scriptGroups.join(", ")})`);
  }
  if (signals.intraWordScriptMixes >= 2) {
    reasons.push(`${signals.intraWordScriptMixes} words mix writing systems internally`);
  }
  if (signals.maxImmediateRepeat >= 6) {
    reasons.push(`a fragment repeats ${signals.maxImmediateRepeat} times in a row`);
  }
  if (signals.malformedRatio >= 0.25 && signals.wordCount >= 8) {
    reasons.push(`${Math.round(signals.malformedRatio * 100)}% of words are malformed`);
  }
  if (reasons.length > 0) return { verdict: "garbled", reasons, signals };

  // Not enough text to judge structurally. Deliberately not "ok": a caller
  // wanting a positive signal from a terse reply should use the canary below.
  if (signals.wordCount < 3) {
    return { verdict: "inconclusive", reasons: ["too short to assess"], signals };
  }

  return { verdict: "ok", reasons: [], signals };
}

/**
 * Canary prompt for the runtime probe: short enough to be cheap on an 8B model,
 * and with a single unambiguous correct answer so compliance is checkable.
 */
export const COHERENCE_CANARY_PROMPT =
  "Reply with exactly this word and nothing else: OK";

const CANARY_EXPECTED = "ok";

/**
 * Evaluate a reply to {@link COHERENCE_CANARY_PROMPT}.
 *
 * Structural corruption is checked FIRST and wins, so a reply that happens to
 * begin with "ok" but then degenerates is still `garbled`. Compliance is only
 * used to turn a clean-but-terse reply ("OK") into a positive verdict — never
 * to fail a model, because a small model may ignore the instruction while being
 * perfectly coherent.
 */
export function evaluateCanaryReply(text: string): CoherenceResult {
  const structural = scoreCoherence(text);
  if (structural.verdict === "garbled") return structural;

  const normalized = text.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.startsWith(CANARY_EXPECTED)) {
    return {
      verdict: "ok",
      reasons: ["matched the canary reply"],
      signals: structural.signals,
    };
  }
  return structural;
}
