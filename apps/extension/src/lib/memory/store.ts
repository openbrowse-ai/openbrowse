// src/lib/memory/store.ts
//
// Memory v2 (file-first) — the store layer.
//
// Memory is a folder tree the agent authors directly with the fs tools:
//   memory/**                     global (about the user + their world)
//   spaces/<spaceId>/memory/**    space-scoped (about the space's project)
//
// The OPFS files are the source of truth. This module maintains a derived,
// rebuildable IndexedDB index (`memoryIndexDb`) for fast keyword + backlink
// search, keyed by file path. It does NOT author files — callers (the fs tools,
// the file viewer's save path, migration) write files, then call `syncPath()`
// to bring the index in line. `reconcile()` rebuilds the whole index from disk.
//
// Links are **bare basenames**: `[[garry-tan]]` resolves to any `…/garry-tan.md`
// in scope regardless of folder (move-safe). A colliding basename relates to all
// same-basename files.

import {
  memoryIndexDb,
  type MemoryIndexRow,
  type MemoryLinkRow,
} from "../memory-db";
import { OPFS } from "../vfs/opfs";
import {
  contentHash,
  keywordScore,
  makeSnippet,
  memoryDirPath,
  parseLinks,
  parseMemory,
  parseMemoryPath,
  searchableText,
  slugify,
  today,
  tokenize,
  type MemoryDoc,
  type MemoryScope,
  type MemoryType,
} from "./format";

export type MemoryRecord = MemoryIndexRow;

export interface SearchResultItem {
  slug: string;
  title: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  domain: string | null;
  path: string;
  snippet: string;
  score: number;
}

export interface RelatedItem {
  slug: string;
  title: string;
  description: string;
  scope: MemoryScope;
  path: string;
}

export interface SearchResult {
  results: SearchResultItem[];
  related: RelatedItem[];
}

/** A node in the memory graph. `path` is null for a dangling link target. */
export interface GraphNode {
  /** File path for real notes; `dangling:<slug>` for unresolved link targets. */
  id: string;
  slug: string;
  title: string;
  description: string;
  scope: MemoryScope | null;
  path: string | null;
  /** How many other notes link to this node (drives node size). */
  backlinks: number;
  dangling: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface MemoryGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Index-row construction from a file
// ---------------------------------------------------------------------------

/** Light title-case of a slug, for a title fallback when frontmatter omits one. */
function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** First non-empty, non-heading line of the compiled truth. */
function firstBodyLine(truth: string): string {
  for (const line of truth.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#"))
      return t.length > 200 ? t.slice(0, 199) + "\u2026" : t;
  }
  return "";
}

function dateToMs(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? fallback : ms;
}

async function indexRowFromFile(
  fullPath: string,
  info: { spaceId: string | null; scope: MemoryScope; slug: string },
): Promise<{ row: MemoryIndexRow; doc: MemoryDoc }> {
  const file = await OPFS.readFileBytes(fullPath);
  const text = await file.text();
  const doc = parseMemory(text);
  const title = doc.title || humanizeSlug(info.slug);
  const description = doc.description || firstBodyLine(doc.truth);
  const enriched: MemoryDoc = { ...doc, title, description };
  const row: MemoryIndexRow = {
    id: fullPath,
    slug: info.slug,
    scope: info.scope,
    spaceId: info.spaceId,
    type: doc.type,
    title,
    description,
    domain: doc.domain,
    aliases: doc.aliases,
    content: doc.truth,
    body: searchableText(enriched),
    contentHash: contentHash(text),
    createdAt: dateToMs(doc.created, file.lastModified),
    updatedAt: dateToMs(doc.updated, file.lastModified),
  };
  return { row, doc };
}

function rowToDoc(row: MemoryIndexRow): MemoryDoc {
  return {
    title: row.title,
    description: row.description,
    type: row.type,
    domain: row.domain,
    aliases: row.aliases,
    created: today(row.createdAt),
    updated: today(row.updatedAt),
    truth: row.content,
    timeline: bodyTimeline(row),
  };
}

function bodyTimeline(row: MemoryIndexRow): string[] {
  const idx = row.content ? row.body.indexOf(row.content) : -1;
  if (idx === -1) return [];
  const after = row.body.slice(idx + row.content.length).trim();
  return after ? after.split(/\r?\n/).filter((l) => l.trim()) : [];
}

export const memoryStore = {
  /** Rows visible from `activeSpaceId`: globals + that space's rows. */
  async list(activeSpaceId: string | null): Promise<MemoryRecord[]> {
    return memoryIndexDb.visibleRows(activeSpaceId);
  },

  async get(id: string): Promise<MemoryRecord | undefined> {
    return memoryIndexDb.getRow(id);
  },

  /**
   * Bring the index in line with the file at `fullPath` after an fs mutation:
   * upsert its row + links if it exists; otherwise remove any index rows at
   * that path (or under it, for a recursive directory delete). No-op for paths
   * outside a memory root.
   */
  async syncPath(fullPath: string): Promise<void> {
    const info = parseMemoryPath(fullPath);
    // A deleted *directory* won't parse as a memory file — handle removal by
    // prefix below even when parseMemoryPath returns null for the dir path.
    const exists = await OPFS.exists(fullPath).catch(() => false);
    if (info && exists) {
      const { row } = await indexRowFromFile(fullPath, info);
      await memoryIndexDb.putRow(row);
      await memoryIndexDb.setLinks(
        row.id,
        row.slug,
        row.spaceId,
        parseLinks(row.body),
      );
      return;
    }
    // Removed: drop the row at this path and any rows beneath it.
    await this.removeUnder(fullPath);
  },

  /** Remove index rows whose id is `prefix` or nested under `prefix/`. */
  async removeUnder(prefix: string): Promise<void> {
    const clean = prefix.replace(/^\/+|\/+$/g, "");
    const rows = await memoryIndexDb.allRows();
    for (const r of rows) {
      if (r.id === clean || r.id === prefix || r.id.startsWith(`${clean}/`)) {
        await memoryIndexDb.deleteRow(r.id);
        await memoryIndexDb.deleteLinksFrom(r.id);
      }
    }
  },

  /**
   * Delete a memory by index id (its OPFS path): removes the file, then the
   * index row + links. Used by the memory management UI.
   */
  async deleteById(id: string): Promise<void> {
    await OPFS.rm(id).catch(() => {});
    await memoryIndexDb.deleteRow(id);
    await memoryIndexDb.deleteLinksFrom(id);
  },

  /**
   * Rebuild the derived index from the OPFS files (source of truth). Walks the
   * global memory tree plus each known space's memory tree, upserts every
   * markdown file, then drops index rows whose file no longer exists.
   */
  async reconcile(knownSpaceIds: string[] = []): Promise<void> {
    const dirs: Array<{ dir: string; spaceId: string | null }> = [
      { dir: memoryDirPath(null), spaceId: null },
      ...knownSpaceIds.map((id) => ({ dir: memoryDirPath(id), spaceId: id })),
    ];
    const seen = new Set<string>();
    for (const { dir } of dirs) {
      for await (const path of OPFS.walk(dir)) {
        if (!path.endsWith(".md")) continue;
        const info = parseMemoryPath(path);
        if (!info) continue;
        try {
          const { row } = await indexRowFromFile(path, info);
          await memoryIndexDb.putRow(row);
          await memoryIndexDb.setLinks(
            row.id,
            row.slug,
            row.spaceId,
            parseLinks(row.body),
          );
          seen.add(row.id);
        } catch {
          // Skip unreadable/malformed files; they remain truth on disk.
        }
      }
    }
    // Drop rows whose file vanished (only within scopes we actually walked, so
    // we don't evict a space's rows just because it wasn't in knownSpaceIds).
    const walkedSpace = new Set(knownSpaceIds);
    for (const r of await memoryIndexDb.allRows()) {
      if (seen.has(r.id)) continue;
      if (r.spaceId !== null && !walkedSpace.has(r.spaceId)) continue;
      await memoryIndexDb.deleteRow(r.id);
      await memoryIndexDb.deleteLinksFrom(r.id);
    }
  },

  /**
   * Hybrid keyword + backlink-boosted search over the visible memory set.
   * Returns ranked results plus a 1-hop "related via links" set.
   */
  async search(
    query: string,
    opts: { activeSpaceId: string | null; limit?: number },
  ): Promise<SearchResult> {
    const limit = opts.limit ?? 5;
    const tokens = tokenize(query);
    const visible = await memoryIndexDb.visibleRows(opts.activeSpaceId);
    if (visible.length === 0 || tokens.length === 0) {
      return { results: [], related: [] };
    }

    const links = await memoryIndexDb.allLinks();
    const visibleIds = new Set(visible.map((r) => r.id));
    const backlinkCount = new Map<string, number>();
    for (const link of links) {
      if (!visibleIds.has(link.sourceId)) continue;
      backlinkCount.set(
        link.targetSlug,
        (backlinkCount.get(link.targetSlug) ?? 0) + 1,
      );
    }

    const scored = visible
      .map((row) => {
        const doc = rowToDoc(row);
        const base = keywordScore(doc, tokens);
        if (base === 0) return null;
        const boost = (backlinkCount.get(row.slug) ?? 0) * 1.5;
        return { row, doc, score: base + boost };
      })
      .filter(
        (x): x is { row: MemoryIndexRow; doc: MemoryDoc; score: number } =>
          x !== null,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results: SearchResultItem[] = scored.map(({ row, doc, score }) => ({
      slug: row.slug,
      title: row.title,
      description: row.description,
      type: row.type,
      scope: row.scope,
      domain: row.domain,
      path: row.id,
      snippet: makeSnippet(doc, tokens),
      score,
    }));

    const related = await this.relatedTo(
      scored.map((s) => s.row),
      links,
      visible,
    );
    return { results, related };
  },

  /** 1-hop neighbors of `seeds` via `[[links]]` (outbound + inbound). */
  async relatedTo(
    seeds: MemoryIndexRow[],
    links: MemoryLinkRow[],
    visible: MemoryIndexRow[],
  ): Promise<RelatedItem[]> {
    if (seeds.length === 0) return [];
    const seedIds = new Set(seeds.map((s) => s.id));
    const seedSlugs = new Set(seeds.map((s) => s.slug));
    const bySlug = new Map<string, MemoryIndexRow>();
    for (const r of visible) if (!bySlug.has(r.slug)) bySlug.set(r.slug, r);

    const neighborSlugs = new Set<string>();
    for (const link of links) {
      if (seedIds.has(link.sourceId)) neighborSlugs.add(link.targetSlug);
      if (seedSlugs.has(link.targetSlug)) neighborSlugs.add(link.sourceSlug);
    }

    const related: RelatedItem[] = [];
    for (const slug of neighborSlugs) {
      if (seedSlugs.has(slug)) continue;
      const row = bySlug.get(slug);
      if (!row) continue;
      related.push({
        slug: row.slug,
        title: row.title,
        description: row.description,
        scope: row.scope,
        path: row.id,
      });
    }
    return related;
  },

  /** Backlinks of a basename slug within the visible set. */
  async backlinks(
    slug: string,
    activeSpaceId: string | null,
  ): Promise<MemoryRecord[]> {
    const edges = await memoryIndexDb.linksByTarget(slug);
    const visible = await memoryIndexDb.visibleRows(activeSpaceId);
    const byId = new Map(visible.map((r) => [r.id, r]));
    const out: MemoryRecord[] = [];
    for (const e of edges) {
      const row = byId.get(e.sourceId);
      if (row) out.push(row);
    }
    return out;
  },

  /**
   * Resolve a bare `[[wikilink]]` name to the OPFS path of a visible memory
   * file (globals + the active space). Matches by basename slug, preferring a
   * space-scoped file over a global one when both share the basename. Returns
   * null when nothing matches (a dangling link). Used to make wikilinks in the
   * rendered memory viewer clickable.
   */
  async resolveVisiblePath(
    name: string,
    activeSpaceId: string | null,
  ): Promise<string | null> {
    const slug = slugify(name);
    const rows = await memoryIndexDb.visibleRows(activeSpaceId);
    const match =
      rows.find((r) => r.slug === slug && r.spaceId === activeSpaceId) ??
      rows.find((r) => r.slug === slug);
    return match?.id ?? null;
  },

  /**
   * Build the `[[wikilink]]` knowledge graph over the visible memory set.
   *
   * Edges are stored as `sourceId` (path) -> `targetSlug` (bare basename), so
   * this resolves each target to node(s):
   *   - a basename shared by several files legitimately fans out to all of them
   *     (matching the link model), each as its own edge;
   *   - an unresolved target becomes a **dangling** node (`dangling:<slug>`),
   *     which surfaces entities the agent referenced but never wrote a note for.
   * Self-links and duplicate edges are dropped. `backlinks` counts inbound edges
   * so the renderer can size hubs.
   */
  async graph(activeSpaceId: string | null): Promise<MemoryGraphData> {
    const rows = await memoryIndexDb.visibleRows(activeSpaceId);
    const links = await memoryIndexDb.allLinks();

    const visibleIds = new Set(rows.map((r) => r.id));
    const bySlug = new Map<string, MemoryIndexRow[]>();
    for (const r of rows) {
      const bucket = bySlug.get(r.slug);
      if (bucket) bucket.push(r);
      else bySlug.set(r.slug, [r]);
    }

    const nodes = new Map<string, GraphNode>();
    for (const r of rows) {
      nodes.set(r.id, {
        id: r.id,
        slug: r.slug,
        title: r.title,
        description: r.description,
        scope: r.scope,
        path: r.id,
        backlinks: 0,
        dangling: false,
      });
    }

    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    const addEdge = (source: string, target: string) => {
      if (source === target) return;
      const key = `${source}\u0000${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source, target });
      const node = nodes.get(target);
      if (node) node.backlinks += 1;
    };

    for (const link of links) {
      if (!visibleIds.has(link.sourceId)) continue;
      const targets = bySlug.get(link.targetSlug);
      if (targets && targets.length > 0) {
        for (const t of targets) addEdge(link.sourceId, t.id);
        continue;
      }
      const id = `dangling:${link.targetSlug}`;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          slug: link.targetSlug,
          title: link.targetSlug,
          description: "",
          scope: null,
          path: null,
          backlinks: 0,
          dangling: true,
        });
      }
      addEdge(link.sourceId, id);
    }

    return { nodes: [...nodes.values()], edges };
  },
};

/** Re-export for callers that write files and need the canonical slug. */
export { slugify };
