import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryIndexDb } from "@/lib/memory-db";
import { installFakeOpfs, type FakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";
import { OPFS } from "@/lib/vfs/opfs";
import {
  memoryFilePath,
  serializeMemory,
  today,
  type MemoryDoc,
} from "../format";
import { memoryStore } from "../store";

let fake: FakeOpfs;

beforeEach(() => {
  indexedDB = new IDBFactory();
  memoryIndexDb._resetForTests();
  fake = installFakeOpfs(vi);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a minimal memory doc. */
function doc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return {
    title: "",
    description: "",
    type: "reference",
    domain: null,
    aliases: [],
    created: today(),
    updated: today(),
    truth: "",
    timeline: [],
    ...overrides,
  };
}

/**
 * File-first write helper: author a memory markdown file at `path` (or the
 * canonical slug path) then bring the index in line, exactly as the fs tools do.
 */
async function writeMemory(
  d: MemoryDoc,
  opts: { spaceId?: string | null; path?: string } = {},
): Promise<string> {
  const spaceId = opts.spaceId ?? null;
  const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const path = opts.path ?? memoryFilePath(slug, spaceId);
  await OPFS.writeFile(path, serializeMemory(d));
  await memoryStore.syncPath(path);
  return path;
}

describe("memoryStore.syncPath", () => {
  it("indexes an authored OPFS markdown file", async () => {
    await writeMemory(
      doc({ title: "Repo URL", truth: "openbrowse-ai/openbrowse" }),
    );
    expect([...fake.files.keys()]).toContain("memory/repo-url.md");

    const row = await memoryStore.get("memory/repo-url.md");
    expect(row?.slug).toBe("repo-url");
    expect(row?.content).toBe("openbrowse-ai/openbrowse");
  });

  it("drops the index row when the file is deleted", async () => {
    const path = await writeMemory(doc({ title: "Temp", truth: "x" }));
    expect(await memoryStore.get(path)).toBeDefined();

    await OPFS.rm(path);
    await memoryStore.syncPath(path);
    expect(await memoryStore.get(path)).toBeUndefined();
  });
});

describe("memoryStore.search", () => {
  it("ranks a keyword match and returns a snippet", async () => {
    await writeMemory(
      doc({
        title: "Staging environment",
        truth: "The staging URL is https://staging.example.com",
      }),
    );
    const res = await memoryStore.search("staging url", {
      activeSpaceId: null,
    });
    expect(res.results.length).toBe(1);
    expect(res.results[0].title).toBe("Staging environment");
    expect(res.results[0].snippet).toContain("staging");
    expect(res.results[0].path).toBe("memory/staging-environment.md");
  });

  it("boosts a memory that others link to via [[wikilinks]]", async () => {
    await writeMemory(doc({ title: "Alpha", truth: "topic apple" }));
    await writeMemory(doc({ title: "Beta", truth: "topic apple" }));
    // Gamma links to Alpha — Alpha gains a backlink boost.
    await writeMemory(
      doc({ title: "Gamma", truth: "see [[alpha]] for details" }),
    );

    const res = await memoryStore.search("apple", { activeSpaceId: null });
    const titles = res.results.map((r) => r.title);
    expect(titles.indexOf("Alpha")).toBeLessThan(titles.indexOf("Beta"));
  });

  it("returns related memories connected via links (inbound + outbound)", async () => {
    await writeMemory(doc({ title: "Acme AI", truth: "a company" }));
    await writeMemory(
      doc({ title: "Person", truth: "works at [[acme-ai]] on widgets" }),
    );

    const res = await memoryStore.search("widgets", { activeSpaceId: null });
    expect(res.results.map((r) => r.title)).toContain("Person");
    // Outbound: Person → Acme AI.
    expect(res.related.map((r) => r.slug)).toContain("acme-ai");
  });

  it("resolves a bare basename link across folders (move-safe)", async () => {
    await writeMemory(doc({ title: "Widget", truth: "the widget" }), {
      path: "memory/projects/widget.md",
    });
    await writeMemory(
      doc({ title: "Note", truth: "about [[widget]] shipping" }),
    );
    const res = await memoryStore.search("shipping", { activeSpaceId: null });
    expect(res.related.map((r) => r.slug)).toContain("widget");
  });

  it("respects scope visibility", async () => {
    await writeMemory(
      doc({ title: "Space Secret", truth: "confidential widget" }),
      { spaceId: "space-1" },
    );
    // Not visible from a different space.
    const other = await memoryStore.search("widget", {
      activeSpaceId: "space-2",
    });
    expect(other.results.length).toBe(0);
    // Visible from its own space.
    const own = await memoryStore.search("widget", {
      activeSpaceId: "space-1",
    });
    expect(own.results.length).toBe(1);
  });
});

describe("memoryStore.reconcile", () => {
  it("rebuilds the index from OPFS files after the index is cleared", async () => {
    await writeMemory(doc({ title: "Global One", truth: "g" }));
    await writeMemory(doc({ title: "Space One", truth: "s" }), {
      spaceId: "space-1",
    });

    // Simulate a lost index.
    await memoryIndexDb.clear();
    expect((await memoryStore.list("space-1")).length).toBe(0);

    await memoryStore.reconcile(["space-1"]);
    const rows = await memoryStore.list("space-1");
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Global One",
      "Space One",
    ]);
  });

  it("drops index rows whose file vanished from a walked scope", async () => {
    const path = await writeMemory(doc({ title: "Gone", truth: "x" }));
    // Delete the file behind the index's back, then reconcile.
    await OPFS.rm(path);
    await memoryStore.reconcile([]);
    expect(await memoryStore.get(path)).toBeUndefined();
  });
});

describe("memoryStore.deleteById", () => {
  it("removes the file, index row, and links", async () => {
    const path = await writeMemory(
      doc({ title: "Doomed", truth: "links to [[survivor]]" }),
    );
    await memoryStore.deleteById(path);

    expect([...fake.files.keys()]).not.toContain("memory/doomed.md");
    expect(await memoryStore.get(path)).toBeUndefined();
    expect((await memoryIndexDb.linksBySource(path)).length).toBe(0);
  });
});

describe("memoryStore.removeUnder", () => {
  it("removes all index rows beneath a directory prefix", async () => {
    await writeMemory(doc({ title: "A", truth: "a" }), {
      path: "memory/proj/a.md",
    });
    await writeMemory(doc({ title: "B", truth: "b" }), {
      path: "memory/proj/b.md",
    });
    await writeMemory(doc({ title: "C", truth: "c" }));

    await memoryStore.removeUnder("memory/proj");
    const rows = await memoryStore.list(null);
    expect(rows.map((r) => r.slug).sort()).toEqual(["c"]);
  });
});

describe("memoryStore.resolveVisiblePath", () => {
  it("resolves a bare name to a visible file path by basename", async () => {
    await writeMemory(doc({ title: "Typa", truth: "a company" }));
    expect(await memoryStore.resolveVisiblePath("typa", null)).toBe(
      "memory/typa.md",
    );
    // Case/format-insensitive via slugify.
    expect(await memoryStore.resolveVisiblePath("Typa", null)).toBe(
      "memory/typa.md",
    );
  });

  it("resolves a nested file by its basename (move-safe)", async () => {
    await writeMemory(doc({ title: "Garry Tan", truth: "x" }), {
      path: "memory/people/garry-tan.md",
    });
    expect(await memoryStore.resolveVisiblePath("garry-tan", null)).toBe(
      "memory/people/garry-tan.md",
    );
  });

  it("prefers a space-scoped file over a global one on a basename collision", async () => {
    await writeMemory(doc({ title: "Pat", truth: "global pat" }));
    await writeMemory(doc({ title: "Pat", truth: "space pat" }), {
      spaceId: "space-1",
    });
    expect(await memoryStore.resolveVisiblePath("pat", "space-1")).toBe(
      "spaces/space-1/memory/pat.md",
    );
    // From no/other space, only the global one is visible.
    expect(await memoryStore.resolveVisiblePath("pat", null)).toBe(
      "memory/pat.md",
    );
  });

  it("returns null for a dangling link", async () => {
    expect(
      await memoryStore.resolveVisiblePath("nonexistent", null),
    ).toBeNull();
  });
});

describe("memoryStore.graph", () => {
  it("builds nodes and resolves basename edges", async () => {
    await writeMemory(doc({ title: "Typa", truth: "a company" }));
    await writeMemory(
      doc({ title: "Andrew Chung", truth: "Founder of [[typa]]" }),
    );

    const g = await memoryStore.graph(null);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      "memory/andrew-chung.md",
      "memory/typa.md",
    ]);
    expect(g.edges).toEqual([
      { source: "memory/andrew-chung.md", target: "memory/typa.md" },
    ]);
    // Backlink count drives node sizing.
    expect(g.nodes.find((n) => n.slug === "typa")?.backlinks).toBe(1);
    expect(g.nodes.find((n) => n.slug === "andrew-chung")?.backlinks).toBe(0);
  });

  it("resolves a link to a nested file by basename", async () => {
    await writeMemory(doc({ title: "Garry Tan", truth: "x" }), {
      path: "memory/people/garry-tan.md",
    });
    await writeMemory(doc({ title: "Note", truth: "met [[garry-tan]]" }));

    const g = await memoryStore.graph(null);
    expect(g.edges).toEqual([
      { source: "memory/note.md", target: "memory/people/garry-tan.md" },
    ]);
  });

  it("fans a colliding basename out to every match", async () => {
    await writeMemory(doc({ title: "Pat", truth: "work pat" }), {
      path: "memory/work/pat.md",
    });
    await writeMemory(doc({ title: "Pat", truth: "friend pat" }), {
      path: "memory/friends/pat.md",
    });
    await writeMemory(doc({ title: "Note", truth: "saw [[pat]]" }));

    const g = await memoryStore.graph(null);
    const targets = g.edges
      .filter((e) => e.source === "memory/note.md")
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(["memory/friends/pat.md", "memory/work/pat.md"]);
  });

  it("represents an unresolved target as a dangling node", async () => {
    await writeMemory(doc({ title: "Note", truth: "about [[ghost]]" }));

    const g = await memoryStore.graph(null);
    const ghost = g.nodes.find((n) => n.slug === "ghost");
    expect(ghost).toMatchObject({
      id: "dangling:ghost",
      dangling: true,
      path: null,
      backlinks: 1,
    });
    expect(g.edges).toEqual([
      { source: "memory/note.md", target: "dangling:ghost" },
    ]);
  });

  it("drops self-links", async () => {
    await writeMemory(doc({ title: "Solo", truth: "see [[solo]]" }));
    const g = await memoryStore.graph(null);
    expect(g.edges).toEqual([]);
  });

  it("only includes the visible scope", async () => {
    await writeMemory(doc({ title: "Global", truth: "g" }));
    await writeMemory(doc({ title: "Scoped", truth: "s" }), {
      spaceId: "space-1",
    });

    const fromSpace = await memoryStore.graph("space-1");
    expect(fromSpace.nodes.map((n) => n.slug).sort()).toEqual([
      "global",
      "scoped",
    ]);

    const fromOther = await memoryStore.graph("space-2");
    expect(fromOther.nodes.map((n) => n.slug)).toEqual(["global"]);
  });
});
