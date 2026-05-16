import type { FavoriteTabAssociation, TidyState } from "@/lib/types";
import type { OverlayTab } from "../OverlayApp";
import { canonicalUrl } from "./canonical";
import { frecencyScore, scoreQuery, type Range } from "./score";
import { shortcutBoost } from "./shortcuts";

export type MatchSource =
  | "tab"
  | "tab-other-space"
  | "favorite-open"
  | "favorite-closed"
  | "bookmark"
  | "history"
  | "closed";

export type MatchAction = "switch" | "open" | "restore";

export interface Match {
  /** Stable unique id for React keys / focus tracking. */
  id: string;
  /** Canonical (deduped) URL key. */
  canonicalUrl: string;
  /** Display URL. */
  url: string;
  /** Display title (already resolved with manual / tidied / native title for tabs). */
  title: string;
  favicon: string;
  score: number;
  source: MatchSource;
  /** Additional sources merged into this match (e.g. an open tab that's also a favorite). */
  extraSources: MatchSource[];
  /** Highlight ranges in the title. */
  titleRanges: Range[];
  /** Highlight ranges in the URL. */
  urlRanges: Range[];
  /** Whether the match was boosted by the personalized Shortcuts store. */
  isShortcut: boolean;

  // Source metadata (optional — present only when applicable)
  tabId?: number;
  windowId?: number;
  pinned?: boolean;
  active?: boolean;
  spaceId?: string;
  spaceName?: string;
  spaceIcon?: string;
  sectionName?: string;
  lastVisitTime?: number;
  visitCount?: number;
  /** Default action to invoke on Enter. */
  action: MatchAction;
}

interface BuildContext {
  query: string;
  /** Current-window/space tabs. */
  tabs: OverlayTab[];
  /** Tabs in other windows/spaces. */
  otherSpaceTabs: OverlayTab[];
  /** Closed-favorite items (favorites that aren't open right now). */
  closedFavorites: OverlayTab[];
  /** Bookmarks (raw, unfiltered). */
  bookmarks: OverlayTab[];
  /** Real recently-closed items from chrome.sessions. */
  recentlyClosed: OverlayTab[];
  /** History search results (live, query-driven). Empty when no query. */
  history: OverlayTab[];
  tidyState: TidyState | null;
  sectionById: Map<string, string>;
  favoriteUrls: Set<string>;
  associatedTabIds: Set<number>;
  associations: FavoriteTabAssociation[];
}

/**
 * Score `query` against a candidate's title(s) and URL.
 *
 * - `titles` — all strings to compare for *scoring* (e.g. native + tidied + manual);
 *   the highest-scoring is used for ranking. May be empty.
 * - `displayTitle` — the string actually rendered in the UI; we only compute
 *   highlight ranges against this exact text so bolded characters always align
 *   with what the user sees, even if the user's typed query matched a different
 *   alternate title.
 * - `url` — the URL string for both scoring and URL highlights.
 */
function scoreCandidate(
  query: string,
  titles: string[],
  displayTitle: string,
  url: string,
): { score: number; titleRanges: Range[]; urlRanges: Range[] } {
  let bestScore = 0;

  // Score against every alternate title to find the best ranking signal.
  for (const t of titles) {
    if (!t) continue;
    const r = scoreQuery(query, t, false);
    if (r.score > bestScore) bestScore = r.score;
  }

  // Score against URL.
  const urlR = url ? scoreQuery(query, url, true) : { score: 0, ranges: [] as Range[] };
  if (urlR.score > bestScore) bestScore = urlR.score;

  // Compute highlight ranges *only* against text that's actually rendered.
  const displayR = displayTitle ? scoreQuery(query, displayTitle, false) : { score: 0, ranges: [] as Range[] };

  return {
    score: bestScore,
    titleRanges: displayR.ranges,
    urlRanges: urlR.ranges,
  };
}

interface RawCandidate {
  source: MatchSource;
  url: string;
  title: string;
  favicon: string;
  // Composite scoring inputs
  matchScore: number;
  titleRanges: Range[];
  urlRanges: Range[];
  // Bonuses applied later
  sourceWeight: number;
  // Source metadata
  tabId?: number;
  windowId?: number;
  pinned?: boolean;
  active?: boolean;
  spaceId?: string;
  spaceName?: string;
  spaceIcon?: string;
  sectionName?: string;
  lastVisitTime?: number;
  visitCount?: number;
}

const SOURCE_WEIGHTS: Record<MatchSource, number> = {
  tab: 1.4,
  "favorite-open": 1.45,
  "favorite-closed": 1.3,
  "tab-other-space": 1.2,
  bookmark: 1.1,
  closed: 1.05,
  history: 1.0,
};

function actionFor(source: MatchSource): MatchAction {
  switch (source) {
    case "tab":
    case "tab-other-space":
    case "favorite-open":
      return "switch";
    case "closed":
      return "restore";
    default:
      return "open";
  }
}

/**
 * Order of merge precedence when the same canonical URL appears from multiple
 * sources. Lower index wins; others become `extraSources`.
 */
const SOURCE_PRIORITY: MatchSource[] = [
  "tab",
  "favorite-open",
  "tab-other-space",
  "favorite-closed",
  "bookmark",
  "closed",
  "history",
];

function priorityOf(source: MatchSource): number {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i < 0 ? 99 : i;
}

/**
 * Build the unified ranked list of Match items from all sources.
 */
export function buildMatches(ctx: BuildContext): Match[] {
  const q = ctx.query.trim();
  const isQuery = q.length > 0;
  const candidates: RawCandidate[] = [];

  // ---- Tabs (current space) ----
  for (const t of ctx.tabs) {
    const isFav = ctx.favoriteUrls.has(t.url) || ctx.associatedTabIds.has(t.id);
    const source: MatchSource = isFav ? "favorite-open" : "tab";
    const titles = uniqueTitles(t, ctx.tidyState);
    const display = displayTitle(t, ctx.tidyState);
    const sc = isQuery
      ? scoreCandidate(q, titles, display, t.url)
      : { score: 1, titleRanges: [], urlRanges: [] };
    if (isQuery && sc.score === 0) continue;
    candidates.push({
      source,
      url: t.url,
      title: display,
      favicon: t.favicon,
      matchScore: sc.score,
      titleRanges: sc.titleRanges,
      urlRanges: sc.urlRanges,
      sourceWeight: SOURCE_WEIGHTS[source],
      tabId: t.id,
      windowId: t.windowId,
      pinned: t.pinned,
      active: t.active,
      sectionName: ctx.tidyState?.tabAssignments[t.id]
        ? ctx.sectionById.get(ctx.tidyState.tabAssignments[t.id])
        : undefined,
    });
  }

  // ---- Tabs (other spaces) — only when querying ----
  if (isQuery) {
    for (const t of ctx.otherSpaceTabs) {
      const sc = scoreCandidate(q, [t.title], t.title, t.url);
      if (sc.score === 0) continue;
      candidates.push({
        source: "tab-other-space",
        url: t.url,
        title: t.title,
        favicon: t.favicon,
        matchScore: sc.score,
        titleRanges: sc.titleRanges,
        urlRanges: sc.urlRanges,
        sourceWeight: SOURCE_WEIGHTS["tab-other-space"],
        tabId: t.id,
        windowId: t.windowId,
        pinned: t.pinned,
        active: t.active,
        spaceName: t.spaceName,
        spaceIcon: t.spaceIcon,
      });
    }
  }

  // ---- Closed favorites (favorites whose URL has no live tab) ----
  for (const f of ctx.closedFavorites) {
    const sc = isQuery
      ? scoreCandidate(q, [f.title], f.title, f.url)
      : { score: 1, titleRanges: [], urlRanges: [] };
    if (isQuery && sc.score === 0) continue;
    candidates.push({
      source: "favorite-closed",
      url: f.url,
      title: f.title,
      favicon: f.favicon,
      matchScore: sc.score,
      titleRanges: sc.titleRanges,
      urlRanges: sc.urlRanges,
      sourceWeight: SOURCE_WEIGHTS["favorite-closed"],
    });
  }

  // ---- Bookmarks (only when querying) ----
  if (isQuery) {
    for (const b of ctx.bookmarks) {
      const sc = scoreCandidate(q, [b.title], b.title, b.url);
      if (sc.score === 0) continue;
      candidates.push({
        source: "bookmark",
        url: b.url,
        title: b.title,
        favicon: b.favicon,
        matchScore: sc.score,
        titleRanges: sc.titleRanges,
        urlRanges: sc.urlRanges,
        sourceWeight: SOURCE_WEIGHTS["bookmark"],
      });
    }
  }

  // ---- Recently closed (chrome.sessions) ----
  for (const c of ctx.recentlyClosed) {
    const sc = isQuery
      ? scoreCandidate(q, [c.title], c.title, c.url)
      : { score: 1, titleRanges: [], urlRanges: [] };
    if (isQuery && sc.score === 0) continue;
    candidates.push({
      source: "closed",
      url: c.url,
      title: c.title,
      favicon: c.favicon,
      matchScore: sc.score,
      titleRanges: sc.titleRanges,
      urlRanges: sc.urlRanges,
      sourceWeight: SOURCE_WEIGHTS["closed"],
      lastVisitTime: c.lastVisitTime,
      visitCount: c.visitCount,
    });
  }

  // ---- History (only when querying) ----
  if (isQuery) {
    for (const h of ctx.history) {
      const sc = scoreCandidate(q, [h.title], h.title, h.url);
      if (sc.score === 0) continue;
      candidates.push({
        source: "history",
        url: h.url,
        title: h.title,
        favicon: h.favicon,
        matchScore: sc.score,
        titleRanges: sc.titleRanges,
        urlRanges: sc.urlRanges,
        sourceWeight: SOURCE_WEIGHTS["history"],
        lastVisitTime: h.lastVisitTime,
        visitCount: h.visitCount,
      });
    }
  }

  // ---- Compute final scores and dedup by canonical URL ----
  const byKey = new Map<string, Match>();
  for (const c of candidates) {
    const key = canonicalUrl(c.url);
    if (!key) continue;

    // Composite score
    const frecency = frecencyScore({
      lastVisitTime: c.lastVisitTime,
      visitCount: c.visitCount,
    });
    const frecencyMultiplier = 1 + Math.min(0.6, frecency * 0.15);
    const boost = isQuery ? shortcutBoost(q, c.url) : 0;
    const isShortcut = boost > 0;

    let score: number;
    if (isQuery) {
      score = c.matchScore * c.sourceWeight * frecencyMultiplier + boost;
    } else {
      // Empty-query ranking: rely on source weight + frecency. Closed and
      // open favorites and tabs all get baseline scores.
      score = c.sourceWeight * 100 * frecencyMultiplier;
    }

    const candidateMatch: Match = {
      id: key,
      canonicalUrl: key,
      url: c.url,
      title: c.title || c.url,
      favicon: c.favicon,
      score,
      source: c.source,
      extraSources: [],
      titleRanges: c.titleRanges,
      urlRanges: c.urlRanges,
      isShortcut,
      tabId: c.tabId,
      windowId: c.windowId,
      pinned: c.pinned,
      active: c.active,
      spaceId: c.spaceId,
      spaceName: c.spaceName,
      spaceIcon: c.spaceIcon,
      sectionName: c.sectionName,
      lastVisitTime: c.lastVisitTime,
      visitCount: c.visitCount,
      action: actionFor(c.source),
    };

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidateMatch);
    } else {
      // Merge: keep the higher-priority source as primary; merge metadata; sum scores cap.
      const winner =
        priorityOf(candidateMatch.source) < priorityOf(existing.source) ? candidateMatch : existing;
      const loser = winner === existing ? candidateMatch : existing;

      const merged: Match = {
        ...winner,
        score: Math.max(winner.score, loser.score) + Math.min(winner.score, loser.score) * 0.1,
        extraSources: dedupeSources([
          ...winner.extraSources,
          ...loser.extraSources,
          loser.source,
        ]).filter((s) => s !== winner.source),
        // Preserve highlight ranges from whichever had more matches
        titleRanges:
          winner.titleRanges.length >= loser.titleRanges.length
            ? winner.titleRanges
            : loser.titleRanges,
        urlRanges:
          winner.urlRanges.length >= loser.urlRanges.length ? winner.urlRanges : loser.urlRanges,
        isShortcut: winner.isShortcut || loser.isShortcut,
        // Keep tab info if present from either side
        tabId: winner.tabId ?? loser.tabId,
        windowId: winner.windowId ?? loser.windowId,
        pinned: winner.pinned ?? loser.pinned,
        active: winner.active ?? loser.active,
        spaceName: winner.spaceName ?? loser.spaceName,
        spaceIcon: winner.spaceIcon ?? loser.spaceIcon,
        sectionName: winner.sectionName ?? loser.sectionName,
        lastVisitTime: winner.lastVisitTime ?? loser.lastVisitTime,
        visitCount: winner.visitCount ?? loser.visitCount,
      };
      byKey.set(key, merged);
    }
  }

  const result = [...byKey.values()];
  result.sort((a, b) => b.score - a.score);
  return result;
}

/** Maximum number of matches to render. */
export const MAX_RESULTS = 50;

function dedupeSources(arr: MatchSource[]): MatchSource[] {
  const seen = new Set<MatchSource>();
  const out: MatchSource[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function uniqueTitles(t: OverlayTab, tidy: TidyState | null): string[] {
  const out = new Set<string>();
  if (t.title) out.add(t.title);
  const tidied = tidy?.tidiedTitles?.[t.id];
  const manual = tidy?.manualTitles?.[t.id];
  if (tidied) out.add(tidied);
  if (manual) out.add(manual);
  return [...out];
}

function displayTitle(t: OverlayTab, tidy: TidyState | null): string {
  return tidy?.manualTitles?.[t.id] ?? tidy?.tidiedTitles?.[t.id] ?? t.title;
}
