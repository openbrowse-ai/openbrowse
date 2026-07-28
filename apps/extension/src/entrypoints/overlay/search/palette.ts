import { Boxes, Layers, MessageCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { ActionItem } from "../components/actions";
import type { Match, MatchAction } from "./matches";
import { scoreQuery, type Range } from "./score";

/**
 * Universal palette search foundation.
 *
 * The tuned URL pipeline (`buildMatches`) is left untouched; its output is
 * adapted into `kind: "url"` results here. Chats, artifacts, spaces, and
 * commands are produced by small isolated builders that all conform to the
 * shared `PaletteResult` union. `groupResults` assembles the sections in a
 * fixed order with per-group caps and optional single-group scoping, and
 * exposes the flattened focus order for keyboard navigation.
 *
 * Everything in this module is pure and free of React / chrome.* so it can be
 * unit-tested in the node Vitest environment.
 */

export type PaletteKind = "url" | "chat" | "artifact" | "space" | "command";

/**
 * How a result's leading glyph is rendered. Results live only in memory (never
 * serialized over messages), so carrying the icon component directly keeps the
 * render layer a trivial switch with no name→component registry.
 */
export type PaletteIcon =
  | { type: "favicon"; url: string }
  | { type: "emoji"; char: string }
  | { type: "component"; Comp: ComponentType<{ className?: string }> };

/**
 * Descriptor (not a closure) for what Enter does. Kept serializable and
 * data-only so the existing URL execution path in OverlayApp stays untouched
 * and every branch is testable.
 */
export type ResultAction =
  | { type: "url"; match: Match; urlAction: MatchAction }
  | { type: "openChat"; conversationId: string }
  | { type: "openArtifact"; artifactId: string }
  | { type: "switchSpace"; spaceId: string }
  | { type: "command"; commandId: string };

export interface PaletteResult {
  kind: PaletteKind;
  /** Stable unique id for React keys / focus tracking (namespaced by kind). */
  id: string;
  title: string;
  subtitle?: string;
  icon: PaletteIcon;
  /** Intra-group ordering only. Never compared across kinds. */
  score: number;
  /** Highlight ranges in the title (from scoreQuery). */
  titleRanges?: Range[];
  action: ResultAction;
}

// ---- Lite input shapes (metadata fetched from the background) ----

export interface ChatLite {
  id: string;
  title: string;
  spaceId: string | null;
  updatedAt: number;
}

export interface ArtifactLite {
  id: string;
  title: string;
  description?: string;
  /** Manifest emoji icon, if any. */
  icon?: string;
  updatedAt: number;
}

export interface SpaceLite {
  id: string;
  name: string;
  icon: string | null;
  position: number;
}

// ---- Builders ------------------------------------------------------------

/**
 * Sort helper: score desc, then a numeric recency tiebreak desc.
 * Used so equal-scoring matches fall back to most-recently-updated.
 */
function byScoreThenRecency<T extends { score: number }>(
  recencyOf: (t: T) => number,
): (a: T, b: T) => number {
  return (a, b) => b.score - a.score || recencyOf(b) - recencyOf(a);
}

/**
 * Chats. Empty query → recency-sorted (feeds the zero-state "Recent chats"
 * block). With a query → title match, dropping non-matches.
 */
export function buildChatMatches(query: string, chats: ChatLite[]): PaletteResult[] {
  const q = query.trim();
  const isQuery = q.length > 0;

  const rows = chats.map((c) => {
    const title = c.title?.trim() || "Untitled chat";
    const r = isQuery ? scoreQuery(q, title, false) : { score: 0, ranges: [] as Range[] };
    return { c, title, score: r.score, ranges: r.ranges };
  });

  const kept = isQuery ? rows.filter((r) => r.score > 0) : rows;
  kept.sort(byScoreThenRecency((r) => r.c.updatedAt));

  return kept.map(({ c, title, score, ranges }) => ({
    kind: "chat" as const,
    id: `chat:${c.id}`,
    title,
    icon: { type: "component", Comp: MessageCircle },
    score,
    titleRanges: isQuery ? ranges : undefined,
    action: { type: "openChat", conversationId: c.id },
  }));
}

/**
 * Artifacts. Scores against title / description / id (best wins) but only
 * highlights the title, since that's what's rendered. Empty query →
 * recency-sorted (feeds "Recent artifacts").
 */
export function buildArtifactMatches(
  query: string,
  artifacts: ArtifactLite[],
): PaletteResult[] {
  const q = query.trim();
  const isQuery = q.length > 0;

  const rows = artifacts.map((a) => {
    const title = a.title?.trim() || a.id;
    let score = 0;
    let ranges: Range[] = [];
    if (isQuery) {
      const t = scoreQuery(q, title, false);
      const d = a.description ? scoreQuery(q, a.description, false) : { score: 0, ranges: [] };
      const i = scoreQuery(q, a.id, false);
      score = Math.max(t.score, d.score, i.score);
      ranges = t.ranges; // highlight the rendered title only
    }
    return { a, title, score, ranges };
  });

  const kept = isQuery ? rows.filter((r) => r.score > 0) : rows;
  kept.sort(byScoreThenRecency((r) => r.a.updatedAt));

  return kept.map(({ a, title, score, ranges }) => ({
    kind: "artifact" as const,
    id: `artifact:${a.id}`,
    title,
    subtitle: a.description,
    icon: a.icon ? { type: "emoji", char: a.icon } : { type: "component", Comp: Boxes },
    score,
    titleRanges: isQuery ? ranges : undefined,
    action: { type: "openArtifact", artifactId: a.id },
  }));
}

/**
 * Spaces. Empty query → every space, ordered by position (feeds the space
 * scope's zero state). With a query → name match, dropping non-matches, sorted
 * by score then position. Spaces don't appear in the unscoped zero state.
 */
export function buildSpaceMatches(query: string, spaces: SpaceLite[]): PaletteResult[] {
  const q = query.trim();
  const isQuery = q.length > 0;

  const rows = spaces.map((s) => {
    const r = isQuery
      ? scoreQuery(q, s.name, false)
      : { score: 0, ranges: [] as Range[] };
    return { s, score: r.score, ranges: r.ranges };
  });

  const kept = isQuery ? rows.filter((r) => r.score > 0) : rows;
  kept.sort((a, b) => b.score - a.score || a.s.position - b.s.position);

  return kept.map(({ s, score, ranges }) => ({
    kind: "space" as const,
    id: `space:${s.id}`,
    title: s.name,
    icon: s.icon ? { type: "emoji", char: s.icon } : { type: "component", Comp: Layers },
    score,
    titleRanges: isQuery ? ranges : undefined,
    action: { type: "switchSpace", spaceId: s.id },
  }));
}

/**
 * Map a filtered `useFilteredActions` item into a command result. Space-type
 * action items are handled by the space builder instead, so callers should
 * pass only `type: "action"` items here.
 */
export function commandToPaletteResult(item: ActionItem, index: number): PaletteResult {
  return {
    kind: "command",
    id: `command:${item.id}`,
    title: item.label,
    icon: { type: "component", Comp: item.icon },
    // Preserve the incoming (already-filtered) order via a descending index.
    score: 1000 - index,
    action: { type: "command", commandId: item.id },
  };
}

/**
 * Adapt a URL-pipeline `Match` into a `PaletteResult` (kind "url"),
 * preserving highlight ranges and the resolved action.
 */
export function matchToPaletteResult(m: Match): PaletteResult {
  return {
    kind: "url",
    id: `url:${m.id}`,
    title: m.title,
    subtitle: m.url,
    icon: { type: "favicon", url: m.favicon },
    score: m.score,
    titleRanges: m.titleRanges,
    action: { type: "url", match: m, urlAction: m.action },
  };
}

// ---- Scope parsing (S3 word tokens) --------------------------------------

const SCOPE_TOKENS: { re: RegExp; scope: PaletteKind }[] = [
  { re: /^chat:\s*/i, scope: "chat" },
  { re: /^(?:artifact|art):\s*/i, scope: "artifact" },
  { re: /^space:\s*/i, scope: "space" },
  { re: /^\/\s*/, scope: "command" },
];

export interface ParsedScope {
  /** Detected scope, or null when the query carries no scope token. */
  scope: PaletteKind | null;
  /** Query with the leading scope token stripped. */
  rest: string;
}

/**
 * Detect a leading scope token (`chat:`, `art:`/`artifact:`, `space:`, `/`)
 * and strip it. Returns the residual query for matching within that scope.
 */
export function parseScope(query: string): ParsedScope {
  for (const { re, scope } of SCOPE_TOKENS) {
    if (re.test(query)) return { scope, rest: query.replace(re, "") };
  }
  return { scope: null, rest: query };
}

// ---- Grouping ------------------------------------------------------------

export const GROUP_ORDER: PaletteKind[] = ["url", "chat", "artifact", "space", "command"];

export const GROUP_LABELS: Record<PaletteKind, string> = {
  url: "Open & visited",
  chat: "Chats",
  artifact: "Artifacts",
  space: "Spaces",
  command: "Commands",
};

export const GROUP_CAPS: Record<PaletteKind, number> = {
  url: 8,
  chat: 4,
  artifact: 4,
  space: 3,
  command: 4,
};

/** Cap applied to the single visible group when a scope is active. */
export const SCOPED_CAP = 50;

export interface GroupInput {
  url: PaletteResult[];
  chat: PaletteResult[];
  artifact: PaletteResult[];
  space: PaletteResult[];
  command: PaletteResult[];
}

export interface GroupOptions {
  /** When set, only this group is shown (with the larger scoped cap). */
  scope?: PaletteKind | null;
  /** Kinds the user has expanded past their cap via "show more". */
  expanded?: ReadonlySet<PaletteKind>;
}

export interface PaletteGroup {
  kind: PaletteKind;
  label: string;
  /** Results after applying the group's cap. */
  results: PaletteResult[];
  /** Pre-cap count, so the UI can render "show N more". */
  total: number;
  /** True when `total` exceeds the shown results. */
  hasMore: boolean;
}

/**
 * Assemble groups in fixed order, applying caps and (optionally) a single-group
 * scope. Empty groups are omitted. See `flattenGroups` for the focus order.
 */
export function groupResults(input: GroupInput, opts: GroupOptions = {}): PaletteGroup[] {
  const { scope = null, expanded } = opts;
  const groups: PaletteGroup[] = [];

  for (const kind of GROUP_ORDER) {
    if (scope && kind !== scope) continue;
    const all = input[kind];
    if (all.length === 0) continue;

    const cap = scope ? SCOPED_CAP : expanded?.has(kind) ? all.length : GROUP_CAPS[kind];
    const results = all.slice(0, cap);
    groups.push({
      kind,
      label: GROUP_LABELS[kind],
      results,
      total: all.length,
      hasMore: all.length > results.length,
    });
  }

  return groups;
}

/** Flatten groups into the linear focus order used by arrow-key navigation. */
export function flattenGroups(groups: PaletteGroup[]): PaletteResult[] {
  return groups.flatMap((g) => g.results);
}
