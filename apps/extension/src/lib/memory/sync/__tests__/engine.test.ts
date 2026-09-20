import { describe, expect, it } from "vitest";

import { serializeMemory, type MemoryDoc } from "../../format";
import {
  conflictArchivePath,
  decide,
  pickConflictWinner,
  reconcile,
  timestampSlug,
} from "../engine";
import { byteLength, sha256 } from "../hash";
import {
  DEFAULT_SYNC_LIMITS,
  type FileEntry,
  type LocalTreePort,
  type MemorySyncTransport,
  type Tombstone,
  type RemoteFileStat,
} from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSide {
  files: Map<string, { content: string; updated: number }>;
}

async function entriesOf(side: FakeSide): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const [path, f] of side.files) {
    out.push({
      path,
      sha256: await sha256(f.content),
      size: byteLength(f.content),
      updated: f.updated,
    });
  }
  return out;
}

/** Metadata-only listing, as the transport contract now requires. */
function statsOf(side: FakeSide): RemoteFileStat[] {
  return [...side.files].map(([path, f]) => ({
    path,
    size: byteLength(f.content),
    updated: f.updated,
  }));
}

function makeLocal(
  initial: Record<string, string> = {},
  mtime = 1_000,
): LocalTreePort & { side: FakeSide; writes: string[]; removals: string[] } {
  const side: FakeSide = { files: new Map() };
  for (const [p, c] of Object.entries(initial)) {
    side.files.set(p, { content: c, updated: mtime });
  }
  const writes: string[] = [];
  const removals: string[] = [];
  return {
    side,
    writes,
    removals,
    list: () => entriesOf(side),
    read: async (p) => {
      const f = side.files.get(p);
      if (!f) throw new Error(`local missing ${p}`);
      return f.content;
    },
    write: async (p, c) => {
      writes.push(p);
      side.files.set(p, { content: c, updated: mtime });
    },
    remove: async (p) => {
      removals.push(p);
      side.files.delete(p);
    },
  };
}

function makeTransport(
  initial: Record<string, string> = {},
  tombstones: Tombstone[] = [],
  mtime = 1_000,
): MemorySyncTransport & {
  side: FakeSide;
  tombstones: Map<string, Tombstone>;
  archived: Array<{ path: string; content: string }>;
  writes: string[];
  deletions: string[];
  /** Paths whose content was hashed — i.e. actually read. */
  hashed: string[];
} {
  const side: FakeSide = { files: new Map() };
  for (const [p, c] of Object.entries(initial)) {
    side.files.set(p, { content: c, updated: mtime });
  }
  const tombMap = new Map(tombstones.map((t) => [t.path, t]));
  const archived: Array<{ path: string; content: string }> = [];
  const writes: string[] = [];
  const deletions: string[] = [];
  const hashed: string[] = [];
  return {
    id: "fake",
    side,
    tombstones: tombMap,
    archived,
    writes,
    deletions,
    hashed,
    status: async () => "granted",
    listFiles: async () => statsOf(side),
    hashFile: async (p) => {
      hashed.push(p);
      const f = side.files.get(p);
      if (!f) throw new Error(`remote missing ${p}`);
      return sha256(f.content);
    },
    readFile: async (p) => {
      const f = side.files.get(p);
      if (!f) throw new Error(`remote missing ${p}`);
      return f.content;
    },
    writeFile: async (p, c) => {
      writes.push(p);
      side.files.set(p, { content: c, updated: mtime });
    },
    deleteFile: async (p) => {
      deletions.push(p);
      side.files.delete(p);
    },
    listTombstones: async () => [...tombMap.values()],
    putTombstone: async (t) => {
      tombMap.set(t.path, t);
    },
    dropTombstone: async (p) => {
      tombMap.delete(p);
    },
    archiveConflict: async (p, c) => {
      archived.push({ path: p, content: c });
    },
    listConflicts: async () =>
      archived.map((a) => ({
        archivedPath: `.openbrowse/conflicts/x/${a.path}`,
        path: a.path,
        at: 0,
      })),
    readConflict: async (archivedPath) => {
      const hit = archived.find(
        (a) => `.openbrowse/conflicts/x/${a.path}` === archivedPath,
      );
      if (!hit) throw new Error(`no archive ${archivedPath}`);
      return hit.content;
    },
    dropConflict: async (archivedPath) => {
      const i = archived.findIndex(
        (a) => `.openbrowse/conflicts/x/${a.path}` === archivedPath,
      );
      if (i >= 0) archived.splice(i, 1);
    },
    withLock: async (fn) => fn(),
  };
}

function doc(overrides: Partial<MemoryDoc> = {}): string {
  return serializeMemory({
    title: "Note",
    description: "",
    type: "reference",
    domain: null,
    aliases: [],
    created: "2026-01-01",
    updated: "2026-01-01",
    truth: "body",
    timeline: [],
    ...overrides,
  });
}

const profile = { id: "profile-a", label: "Work" };

async function baselineOf(
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) out[p] = await sha256(c);
  return out;
}

// ---------------------------------------------------------------------------
// decide(): the full case table
// ---------------------------------------------------------------------------

describe("decide", () => {
  const t = true;
  const f = false;

  it("does nothing when both sides already agree", () => {
    expect(
      decide({ local: "a", remote: "a", base: "a", tombstoned: f }),
    ).toEqual({
      kind: "noop",
    });
    // Agreement wins even if the baseline is stale or absent.
    expect(
      decide({ local: "a", remote: "a", base: "old", tombstoned: f }),
    ).toEqual({
      kind: "noop",
    });
    expect(
      decide({ local: "a", remote: "a", base: null, tombstoned: f }),
    ).toEqual({
      kind: "noop",
    });
  });

  it("pushes when only the local side moved", () => {
    expect(
      decide({ local: "b", remote: "a", base: "a", tombstoned: f }),
    ).toEqual({
      kind: "push",
    });
  });

  it("pulls when only the remote side moved", () => {
    expect(
      decide({ local: "a", remote: "b", base: "a", tombstoned: f }),
    ).toEqual({
      kind: "pull",
    });
  });

  it("conflicts when both sides moved off the base", () => {
    expect(
      decide({ local: "b", remote: "c", base: "a", tombstoned: f }),
    ).toEqual({
      kind: "conflict",
    });
  });

  it("conflicts when two profiles independently created the same path", () => {
    expect(
      decide({ local: "b", remote: "c", base: null, tombstoned: f }),
    ).toEqual({
      kind: "conflict",
    });
  });

  it("pushes a brand-new local file", () => {
    expect(
      decide({ local: "a", remote: null, base: null, tombstoned: f }),
    ).toEqual({
      kind: "push",
    });
  });

  it("pulls a brand-new remote file", () => {
    expect(
      decide({ local: null, remote: "a", base: null, tombstoned: f }),
    ).toEqual({
      kind: "pull",
    });
  });

  it("accepts a remote delete when the local copy is untouched", () => {
    expect(
      decide({ local: "a", remote: null, base: "a", tombstoned: t }),
    ).toEqual({
      kind: "delete-local",
    });
  });

  it("propagates a local delete when the remote copy is untouched", () => {
    expect(
      decide({ local: null, remote: "a", base: "a", tombstoned: f }),
    ).toEqual({
      kind: "delete-remote",
    });
  });

  it("lets a local edit beat a remote delete", () => {
    expect(
      decide({ local: "b", remote: null, base: "a", tombstoned: t }),
    ).toEqual({
      kind: "resurrect",
      direction: "push",
    });
  });

  it("lets a remote edit beat a local delete", () => {
    expect(
      decide({ local: null, remote: "b", base: "a", tombstoned: f }),
    ).toEqual({
      kind: "resurrect",
      direction: "pull",
    });
  });

  it("restores a vault file that vanished without a tombstone", () => {
    // Never a delete: only OpenBrowse's own delete path writes tombstones, so a
    // merely-absent file is far more likely a half-synced folder than intent.
    expect(
      decide({ local: "a", remote: null, base: "a", tombstoned: f }),
    ).toEqual({
      kind: "push",
    });
  });

  it("forgets a path deleted on both sides", () => {
    expect(
      decide({ local: null, remote: null, base: "a", tombstoned: f }),
    ).toEqual({
      kind: "drop-baseline",
    });
    expect(
      decide({ local: null, remote: null, base: null, tombstoned: f }),
    ).toEqual({
      kind: "noop",
    });
  });
});

// ---------------------------------------------------------------------------
// Conflict winner
// ---------------------------------------------------------------------------

describe("pickConflictWinner", () => {
  it("prefers the newer `updated` frontmatter date over mtime", () => {
    // Remote has the older mtime but the newer note date; the note date wins
    // because mtime is disturbed by backups and cloud clients.
    const winner = pickConflictWinner({
      localContent: doc({ updated: "2026-01-01" }),
      localUpdated: 9_999,
      remoteContent: doc({ updated: "2026-02-01" }),
      remoteUpdated: 1,
    });
    expect(winner).toBe("remote");
  });

  it("falls back to mtime when the dates tie", () => {
    expect(
      pickConflictWinner({
        localContent: doc({ updated: "2026-01-01", truth: "a" }),
        localUpdated: 1,
        remoteContent: doc({ updated: "2026-01-01", truth: "b" }),
        remoteUpdated: 2,
      }),
    ).toBe("remote");
  });

  it("is deterministic when dates and mtimes both tie", () => {
    expect(
      pickConflictWinner({
        localContent: doc({ truth: "a" }),
        localUpdated: 5,
        remoteContent: doc({ truth: "b" }),
        remoteUpdated: 5,
      }),
    ).toBe("local");
  });
});

describe("timestampSlug", () => {
  it("is filesystem-safe and chronologically sortable", () => {
    const slug = timestampSlug(Date.parse("2026-09-07T14:22:01.500Z"));
    expect(slug).toBe("2026-09-07T14-22-01Z");
    expect(slug).not.toMatch(/[:/\\]/);
    expect(
      conflictArchivePath("memory/a.md", Date.parse("2026-09-07T14:22:01Z")),
    ).toBe(".openbrowse/conflicts/2026-09-07T14-22-01Z/memory/a.md");
  });
});

// ---------------------------------------------------------------------------
// reconcile()
// ---------------------------------------------------------------------------

describe("reconcile", () => {
  it("performs a union merge on first sync and deletes nothing", async () => {
    const local = makeLocal({ "memory/mine.md": doc({ title: "Mine" }) });
    const transport = makeTransport({
      "memory/theirs.md": doc({ title: "Theirs" }),
    });

    const { result, baseline } = await reconcile({
      local,
      transport,
      baseline: {},
      profile,
    });

    expect(result.pulled).toEqual(["memory/theirs.md"]);
    expect(result.pushed).toEqual(["memory/mine.md"]);
    expect(result.deletedLocal).toEqual([]);
    expect(result.deletedRemote).toEqual([]);
    expect([...local.side.files.keys()].sort()).toEqual([
      "memory/mine.md",
      "memory/theirs.md",
    ]);
    expect([...transport.side.files.keys()].sort()).toEqual([
      "memory/mine.md",
      "memory/theirs.md",
    ]);
    expect(Object.keys(baseline).sort()).toEqual([
      "memory/mine.md",
      "memory/theirs.md",
    ]);
  });

  it("is idempotent — a second pass writes nothing", async () => {
    const local = makeLocal({ "memory/a.md": doc({ title: "A" }) });
    const transport = makeTransport({ "memory/b.md": doc({ title: "B" }) });

    const first = await reconcile({ local, transport, baseline: {}, profile });
    expect(first.result.pulled.length + first.result.pushed.length).toBe(2);

    local.writes.length = 0;
    transport.writes.length = 0;

    const second = await reconcile({
      local,
      transport,
      baseline: first.baseline,
      profile,
    });

    expect(second.result.pulled).toEqual([]);
    expect(second.result.pushed).toEqual([]);
    expect(local.writes).toEqual([]);
    expect(transport.writes).toEqual([]);
  });

  it("propagates a local delete as a remote delete plus a tombstone", async () => {
    const content = doc({ title: "Gone" });
    const local = makeLocal({});
    const transport = makeTransport({ "memory/gone.md": content });

    const { result, baseline } = await reconcile({
      local,
      transport,
      baseline: await baselineOf({ "memory/gone.md": content }),
      profile,
    });

    expect(result.deletedRemote).toEqual(["memory/gone.md"]);
    expect(transport.side.files.has("memory/gone.md")).toBe(false);
    const tomb = transport.tombstones.get("memory/gone.md");
    expect(tomb?.profileLabel).toBe("Work");
    expect(baseline["memory/gone.md"]).toBeUndefined();
  });

  it("applies a remote delete locally", async () => {
    const content = doc({ title: "Gone" });
    const local = makeLocal({ "memory/gone.md": content });
    const transport = makeTransport({}, [
      {
        path: "memory/gone.md",
        deletedAt: 500,
        profileId: "profile-b",
        profileLabel: "Personal",
      },
    ]);

    const { result } = await reconcile({
      local,
      transport,
      baseline: await baselineOf({ "memory/gone.md": content }),
      profile,
      now: () => 1_000,
    });

    expect(result.deletedLocal).toEqual(["memory/gone.md"]);
    expect(local.side.files.has("memory/gone.md")).toBe(false);
  });

  it("resurrects a locally edited note that was deleted elsewhere", async () => {
    const original = doc({ title: "Contested", truth: "old" });
    const edited = doc({ title: "Contested", truth: "new" });
    const local = makeLocal({ "memory/contested.md": edited });
    const transport = makeTransport({}, [
      {
        path: "memory/contested.md",
        deletedAt: 500,
        profileId: "profile-b",
        profileLabel: "Personal",
      },
    ]);

    const { result } = await reconcile({
      local,
      transport,
      baseline: await baselineOf({ "memory/contested.md": original }),
      profile,
      now: () => 1_000,
    });

    expect(result.resurrected).toEqual(["memory/contested.md"]);
    expect(result.deletedLocal).toEqual([]);
    // The tombstone must be cleared, or the next pass would delete the note.
    expect(transport.tombstones.has("memory/contested.md")).toBe(false);
    expect(transport.side.files.get("memory/contested.md")?.content).toBe(
      edited,
    );
  });

  it("archives the losing copy on conflict and never writes it into the tree", async () => {
    const base = doc({ title: "Both", truth: "base" });
    const localContent = doc({
      title: "Both",
      truth: "local",
      updated: "2026-03-01",
    });
    const remoteContent = doc({
      title: "Both",
      truth: "remote",
      updated: "2026-02-01",
    });

    const local = makeLocal({ "memory/both.md": localContent });
    const transport = makeTransport({ "memory/both.md": remoteContent });

    const { result } = await reconcile({
      local,
      transport,
      baseline: await baselineOf({ "memory/both.md": base }),
      profile,
      now: () => Date.parse("2026-09-07T14:22:01Z"),
    });

    expect(result.conflicts).toEqual([
      {
        path: "memory/both.md",
        winner: "local",
        archivedAt: ".openbrowse/conflicts/2026-09-07T14-22-01Z/memory/both.md",
      },
    ]);
    // Loser preserved, but outside the memory tree so it never gets indexed and
    // never makes a `[[wikilink]]` basename ambiguous.
    expect(transport.archived).toEqual([
      { path: "memory/both.md", content: remoteContent },
    ]);
    expect([...transport.side.files.keys()]).toEqual(["memory/both.md"]);
    expect(transport.side.files.get("memory/both.md")?.content).toBe(
      localContent,
    );
  });

  it("converges after a conflict — the next pass is a no-op", async () => {
    const base = doc({ truth: "base" });
    const local = makeLocal({
      "memory/x.md": doc({ truth: "local", updated: "2026-03-01" }),
    });
    const transport = makeTransport({
      "memory/x.md": doc({ truth: "remote", updated: "2026-02-01" }),
    });

    const first = await reconcile({
      local,
      transport,
      baseline: await baselineOf({ "memory/x.md": base }),
      profile,
    });
    expect(first.result.conflicts).toHaveLength(1);

    const second = await reconcile({
      local,
      transport,
      baseline: first.baseline,
      profile,
    });
    expect(second.result.conflicts).toEqual([]);
    expect(second.result.pushed).toEqual([]);
    expect(second.result.pulled).toEqual([]);
  });

  it("restores a vault file that disappeared without a tombstone", async () => {
    const content = doc({ title: "Restored" });
    const local = makeLocal({ "memory/restored.md": content });
    const transport = makeTransport({});

    const { result } = await reconcile({
      local,
      transport,
      baseline: await baselineOf({ "memory/restored.md": content }),
      profile,
    });

    expect(result.pushed).toEqual(["memory/restored.md"]);
    expect(result.deletedLocal).toEqual([]);
    expect(transport.side.files.has("memory/restored.md")).toBe(true);
  });

  it("garbage-collects tombstones past their TTL", async () => {
    const transport = makeTransport({}, [
      {
        path: "memory/ancient.md",
        deletedAt: 0,
        profileId: "profile-b",
        profileLabel: "Personal",
      },
      {
        path: "memory/recent.md",
        deletedAt: DEFAULT_SYNC_LIMITS.tombstoneTtlMs,
        profileId: "profile-b",
        profileLabel: "Personal",
      },
    ]);

    await reconcile({
      local: makeLocal({}),
      transport,
      baseline: {},
      profile,
      now: () => DEFAULT_SYNC_LIMITS.tombstoneTtlMs + 1,
    });

    expect(transport.tombstones.has("memory/ancient.md")).toBe(false);
    expect(transport.tombstones.has("memory/recent.md")).toBe(true);
  });

  describe("rejects untrusted vault input", () => {
    it("refuses path traversal, dotfiles, and absolute paths", async () => {
      const local = makeLocal({});
      const transport = makeTransport({
        "memory/../escape.md": doc(),
        "memory/./x.md": doc(),
        "/memory/abs.md": doc(),
        "memory/.hidden.md": doc(),
        "memory/back\\slash.md": doc(),
      });

      const { result } = await reconcile({
        local,
        transport,
        baseline: {},
        profile,
      });

      expect(result.pulled).toEqual([]);
      expect(local.side.files.size).toBe(0);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        "unsafe-path",
        "unsafe-path",
        "unsafe-path",
        "unsafe-path",
        "unsafe-path",
      ]);
    });

    it("refuses non-markdown files and anything outside global memory", async () => {
      const local = makeLocal({});
      const transport = makeTransport({
        "memory/notes.txt": "plain",
        "spaces/abc/memory/scoped.md": doc(),
        "elsewhere/thing.md": doc(),
      });

      const { result } = await reconcile({
        local,
        transport,
        baseline: {},
        profile,
      });

      expect(result.pulled).toEqual([]);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        "not-global-memory",
        "not-global-memory",
        "not-global-memory",
      ]);
    });

    it("refuses oversized files and caps the file count", async () => {
      const local = makeLocal({});
      const big = "x".repeat(2_000);
      const transport = makeTransport({
        "memory/big.md": big,
        "memory/a.md": doc(),
        "memory/b.md": doc(),
      });

      const { result } = await reconcile({
        local,
        transport,
        baseline: {},
        profile,
        limits: { maxFiles: 1, maxBytes: 1_000, tombstoneTtlMs: 1_000 },
      });

      expect(result.skipped).toEqual(
        expect.arrayContaining([
          { path: "memory/big.md", reason: "too-large" },
          { path: "memory/b.md", reason: "too-many-files" },
        ]),
      );
      expect(result.pulled).toEqual(["memory/a.md"]);
    });

    it("never reads a file it is going to reject", async () => {
      // The caps exist to bound a runaway or hostile vault. Hashing the whole tree
      // up front would mean every file had already been decoded into memory by the
      // time the caps rejected it, making them decorative.
      const local = makeLocal({});
      const transport = makeTransport({
        "memory/huge.md": "x".repeat(4_000),
        "memory/../escape.md": doc(),
        "memory/notes.txt": "plain",
        "memory/fine.md": doc(),
      });

      const { result } = await reconcile({
        local,
        transport,
        baseline: {},
        profile,
        limits: { maxFiles: 10, maxBytes: 1_000, tombstoneTtlMs: 1_000 },
      });

      expect(transport.hashed).toEqual(["memory/fine.md"]);
      expect(result.pulled).toEqual(["memory/fine.md"]);
      expect(result.skipped.map((s) => s.path).sort()).toEqual([
        "memory/../escape.md",
        "memory/huge.md",
        "memory/notes.txt",
      ]);
    });

    it("stops hashing once the file cap is reached", async () => {
      const transport = makeTransport({
        "memory/a.md": doc(),
        "memory/b.md": doc(),
        "memory/c.md": doc(),
      });

      await reconcile({
        local: makeLocal({}),
        transport,
        baseline: {},
        profile,
        limits: { maxFiles: 2, maxBytes: 1_000_000, tombstoneTtlMs: 1_000 },
      });

      expect(transport.hashed).toHaveLength(2);
    });

    it("ignores a tombstone that points outside the memory tree", async () => {
      const content = doc();
      const local = makeLocal({ "memory/keep.md": content });
      const transport = makeTransport({ "memory/keep.md": content }, [
        {
          path: "../../etc/passwd",
          deletedAt: 1,
          profileId: "evil",
          profileLabel: "evil",
        },
      ]);

      const { result } = await reconcile({
        local,
        transport,
        baseline: await baselineOf({ "memory/keep.md": content }),
        profile,
      });

      expect(result.deletedLocal).toEqual([]);
      expect(local.removals).toEqual([]);
    });
  });
});
