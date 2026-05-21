import { hostBoundsInUrl, tokens } from "./tokenize";

export type Range = [number, number];

export interface ScoreResult {
  /** Numeric relevance, higher is better. 0 means no match. */
  score: number;
  /** Character ranges in the target where query tokens matched. */
  ranges: Range[];
}

const WORD_BOUNDARY = /[\s\-_./?#=&:;,!@()[\]{}<>"'`~]/;

function isWordStart(target: string, idx: number): boolean {
  if (idx === 0) return true;
  return WORD_BOUNDARY.test(target[idx - 1]);
}

/**
 * Score a query against a target string. Implementation:
 *
 * - Split query into tokens; each token must be found contiguously in the target.
 * - If any query token cannot be found, returns score 0.
 * - Per-token scoring rewards length, word-start matches, and (for URL targets) host-bounded matches.
 * - All-tokens-matched bonus added on success.
 *
 * Targets shorter than the query (in chars) get a length bonus so a short title
 * with a perfect match outranks a long URL with the same match.
 */
export function scoreQuery(query: string, target: string, isUrl = false): ScoreResult {
  if (!query || !target) return { score: 0, ranges: [] };
  const qTokens = tokens(query);
  if (qTokens.length === 0) return { score: 0, ranges: [] };

  const tLower = target.toLowerCase();
  const hostBounds = isUrl ? hostBoundsInUrl(target) : null;

  let score = 0;
  const ranges: Range[] = [];
  let cursor = 0; // soft-prefer matches in order, but allow any-position fallback
  let allInOrder = true;

  for (const qTok of qTokens) {
    let idx = tLower.indexOf(qTok, cursor);
    if (idx < 0) {
      idx = tLower.indexOf(qTok);
      allInOrder = false;
    }
    if (idx < 0) {
      return { score: 0, ranges: [] };
    }

    const tokLen = qTok.length;
    let tokScore = tokLen * 10;

    if (isWordStart(tLower, idx)) tokScore += 8;
    if (idx === 0) tokScore += 6;
    if (hostBounds && idx >= hostBounds[0] && idx < hostBounds[1]) tokScore += 12;

    // Whole-token match (matched portion ends on a word boundary too)
    const endIdx = idx + tokLen;
    if (endIdx === tLower.length || WORD_BOUNDARY.test(tLower[endIdx])) {
      tokScore += 4;
    }

    score += tokScore;
    ranges.push([idx, endIdx]);
    cursor = endIdx;
  }

  // Bonuses
  score += 20; // all tokens matched
  if (allInOrder) score += 10;

  // Length bonus: favor short targets (e.g. short title beats long URL with same match).
  // Cap so absurdly short strings don't dominate.
  const lenPenalty = Math.min(tLower.length / 100, 1);
  score = Math.round(score * (1.2 - lenPenalty * 0.4));

  return { score, ranges: mergeRanges(ranges) };
}

function mergeRanges(input: Range[]): Range[] {
  if (input.length <= 1) return input;
  const sorted = [...input].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const curr = sorted[i];
    if (curr[0] <= last[1]) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      out.push(curr);
    }
  }
  return out;
}

/**
 * Frequency-recency score for a history-like item.
 *
 * Uses log-damped visit count over log-damped age in days, with a +2 offset
 * on the divisor so very-recent items (ageDays floored at 0.1) don't blow up
 * to infinity. Returns roughly [0, 5+]: highly visited recent pages score
 * ~3-5, sporadic old pages score < 1.
 */
export function frecencyScore(item: { lastVisitTime?: number; visitCount?: number }): number {
  const visits = Math.max(item.visitCount ?? 0, 1);
  const ageMs = Date.now() - (item.lastVisitTime ?? 0);
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 0.1);
  return Math.log10(1 + visits) / Math.log10(2 + ageDays);
}
