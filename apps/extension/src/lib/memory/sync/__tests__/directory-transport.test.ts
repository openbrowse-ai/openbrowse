import { describe, expect, it } from "vitest";

import { makeFakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";
import {
    createDirectoryTransport,
    ensureVaultMeta,
    readStatus,
} from "../directory-transport";
import { byteLength, sha256 } from "../hash";

/**
 * The fake OPFS handle implements the same slice of the File System Access API a
 * real directory handle exposes, so it stands in for a vault. It deliberately
 * has no `move()` and no `queryPermission()`, which exercises the transport's
 * fallback paths — the ones most likely to be what actually runs, since `move()`
 * support on local (non-OPFS) handles is not guaranteed.
 */
function makeVault() {
  const fake = makeFakeOpfs();
  return { root: fake.root, files: fake.files };
}

/** A handle whose permission state we control. */
function withPermission(
  root: FileSystemDirectoryHandle,
  state: PermissionState,
): FileSystemDirectoryHandle {
  return Object.assign(Object.create(Object.getPrototypeOf(root)), root, {
    queryPermission: async () => state,
  }) as FileSystemDirectoryHandle;
}

describe("createDirectoryTransport", () => {
  it("round-trips a memory file and reports its hash and size", async () => {
    const { root } = makeVault();
    const transport = createDirectoryTransport(root);

    await transport.writeFile("memory/a.md", "hello");

    expect(await transport.readFile("memory/a.md")).toBe("hello");
    const listed = await transport.listFiles();
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe("memory/a.md");
    expect(listed[0].sha256).toBe(await sha256("hello"));
    expect(listed[0].size).toBe(byteLength("hello"));
  });

  it("writes and lists nested memory paths", async () => {
    const { root } = makeVault();
    const transport = createDirectoryTransport(root);

    await transport.writeFile("memory/people/garry-tan.md", "x");

    expect((await transport.listFiles()).map((f) => f.path)).toEqual([
      "memory/people/garry-tan.md",
    ]);
  });

  it("keeps sync metadata out of the file listing", async () => {
    // `.openbrowse/**` is only reachable under a dotted segment, which
    // `isSafeRelPath` rejects — so metadata can never be read back as a note.
    const { root } = makeVault();
    const transport = createDirectoryTransport(root);

    await transport.writeFile("memory/a.md", "note");
    await transport.putTombstone({
      path: "memory/gone.md",
      deletedAt: 1,
      profileId: "p",
      profileLabel: "Work",
    });
    await ensureVaultMeta(root);

    expect((await transport.listFiles()).map((f) => f.path)).toEqual([
      "memory/a.md",
    ]);
  });

  it("treats a missing file as absent rather than an error", async () => {
    const { root } = makeVault();
    const transport = createDirectoryTransport(root);

    expect(await transport.listFiles()).toEqual([]);
    await expect(transport.readFile("memory/nope.md")).rejects.toThrow(/missing/);
    // Deleting something already gone is a no-op success, matching `OPFS.rm`.
    await expect(transport.deleteFile("memory/nope.md")).resolves.toBeUndefined();
  });

  it("deletes a file", async () => {
    const { root } = makeVault();
    const transport = createDirectoryTransport(root);
    await transport.writeFile("memory/a.md", "x");

    await transport.deleteFile("memory/a.md");

    expect(await transport.listFiles()).toEqual([]);
  });

  describe("tombstones", () => {
    it("round-trips and drops by path", async () => {
      const { root } = makeVault();
      const transport = createDirectoryTransport(root);
      const tombstone = {
        path: "memory/gone.md",
        deletedAt: 1_234,
        profileId: "profile-a",
        profileLabel: "Work",
      };

      await transport.putTombstone(tombstone);
      expect(await transport.listTombstones()).toEqual([tombstone]);

      await transport.dropTombstone("memory/gone.md");
      expect(await transport.listTombstones()).toEqual([]);
    });

    it("names the file by path hash, so nesting never leaks into it", async () => {
      const { root, files } = makeVault();
      const transport = createDirectoryTransport(root);

      await transport.putTombstone({
        path: "memory/deep/nested/note.md",
        deletedAt: 1,
        profileId: "p",
        profileLabel: "L",
      });

      const names = [...files.keys()].filter((k) => k.includes("tombstones"));
      expect(names).toHaveLength(1);
      expect(names[0]).toBe(
        `.openbrowse/tombstones/${await sha256("memory/deep/nested/note.md")}.json`,
      );
    });

    it("ignores a corrupt tombstone rather than failing the listing", async () => {
      const { root, files } = makeVault();
      const transport = createDirectoryTransport(root);
      await transport.putTombstone({
        path: "memory/good.md",
        deletedAt: 1,
        profileId: "p",
        profileLabel: "L",
      });
      files.set(
        ".openbrowse/tombstones/garbage.json",
        new TextEncoder().encode("{ not json"),
      );

      expect((await transport.listTombstones()).map((t) => t.path)).toEqual([
        "memory/good.md",
      ]);
    });

    it("dropping an absent tombstone is a no-op", async () => {
      const transport = createDirectoryTransport(makeVault().root);
      await expect(
        transport.dropTombstone("memory/never.md"),
      ).resolves.toBeUndefined();
    });
  });

  describe("conflict archive", () => {
    it("archives outside the memory tree and reads back", async () => {
      const { root } = makeVault();
      const transport = createDirectoryTransport(root);
      const at = Date.parse("2026-09-07T14:22:01Z");

      await transport.archiveConflict("memory/both.md", "losing copy", at);

      const conflicts = await transport.listConflicts();
      expect(conflicts).toEqual([
        {
          archivedPath:
            ".openbrowse/conflicts/2026-09-07T14-22-01Z/memory/both.md",
          path: "memory/both.md",
          at,
        },
      ]);
      expect(await transport.readConflict(conflicts[0].archivedPath)).toBe(
        "losing copy",
      );
      // Critically, the archive is not a memory file.
      expect(await transport.listFiles()).toEqual([]);
    });

    it("sorts newest first and drops on request", async () => {
      const transport = createDirectoryTransport(makeVault().root);
      const older = Date.parse("2026-09-01T00:00:00Z");
      const newer = Date.parse("2026-09-07T00:00:00Z");

      await transport.archiveConflict("memory/a.md", "old", older);
      await transport.archiveConflict("memory/b.md", "new", newer);

      let conflicts = await transport.listConflicts();
      expect(conflicts.map((c) => c.path)).toEqual([
        "memory/b.md",
        "memory/a.md",
      ]);

      await transport.dropConflict(conflicts[0].archivedPath);
      conflicts = await transport.listConflicts();
      expect(conflicts.map((c) => c.path)).toEqual(["memory/a.md"]);
    });

    it("refuses a conflict path outside the archive", async () => {
      const transport = createDirectoryTransport(makeVault().root);
      await expect(transport.readConflict("memory/a.md")).rejects.toThrow(
        /not a conflict archive path/,
      );
      await expect(
        transport.readConflict(".openbrowse/conflicts/../../escape.md"),
      ).rejects.toThrow(/unsafe conflict path/);
    });
  });

  describe("path safety", () => {
    const forbidden = [
      "memory/../escape.md",
      "/memory/abs.md",
      "memory\\win.md",
      ".openbrowse/vault.json",
    ];

    for (const path of forbidden) {
      it(`refuses to write ${path}`, async () => {
        const transport = createDirectoryTransport(makeVault().root);
        await expect(transport.writeFile(path, "x")).rejects.toThrow(
          /unsafe vault path/,
        );
        await expect(transport.readFile(path)).rejects.toThrow(
          /unsafe vault path/,
        );
        await expect(transport.deleteFile(path)).rejects.toThrow(
          /unsafe vault path/,
        );
      });
    }
  });

  describe("advisory lock", () => {
    it("runs the body and releases afterwards", async () => {
      const { root, files } = makeVault();
      const transport = createDirectoryTransport(root);
      let ran = false;

      const out = await transport.withLock(async () => {
        ran = true;
        expect(files.has(".openbrowse/lock")).toBe(true);
        return "result";
      });

      expect(ran).toBe(true);
      expect(out).toBe("result");
      expect(files.has(".openbrowse/lock")).toBe(false);
    });

    it("still runs the body when another profile holds a fresh lock", async () => {
      // The lock is advisory only — the File System Access API has no atomic
      // exclusive create, so it cannot be load-bearing. Reconciliation is safe
      // regardless: the worst outcome of a lost race is an extra conflict
      // archive entry.
      const { root, files } = makeVault();
      files.set(
        ".openbrowse/lock",
        new TextEncoder().encode(JSON.stringify({ acquiredAt: Date.now() })),
      );
      const transport = createDirectoryTransport(root);

      let ran = false;
      await transport.withLock(async () => {
        ran = true;
      });

      expect(ran).toBe(true);
      // Not ours to release, so the holder's lock survives.
      expect(files.has(".openbrowse/lock")).toBe(true);
    });

    it("steals a stale lock", async () => {
      const { root, files } = makeVault();
      files.set(
        ".openbrowse/lock",
        new TextEncoder().encode(JSON.stringify({ acquiredAt: 0 })),
      );
      const transport = createDirectoryTransport(root);

      await transport.withLock(async () => {});

      expect(files.has(".openbrowse/lock")).toBe(false);
    });
  });

  describe("vault identity", () => {
    it("mints an id once and reuses it", async () => {
      const { root } = makeVault();
      const first = await ensureVaultMeta(root);
      const second = await ensureVaultMeta(root);

      expect(first.vaultId).toBeTruthy();
      expect(second.vaultId).toBe(first.vaultId);
    });

    it("rewrites a corrupt vault.json instead of failing", async () => {
      // Losing the id costs one full re-merge, which never deletes — far better
      // than refusing to sync.
      const { root, files } = makeVault();
      files.set(
        ".openbrowse/vault.json",
        new TextEncoder().encode("{ truncated"),
      );

      const meta = await ensureVaultMeta(root);
      expect(meta.vaultId).toBeTruthy();
      expect((await ensureVaultMeta(root)).vaultId).toBe(meta.vaultId);
    });
  });

  describe("readStatus", () => {
    it("is unset with no handle", async () => {
      expect(await readStatus(null)).toBe("unset");
    });

    it("is granted for a reachable handle", async () => {
      expect(await readStatus(makeVault().root)).toBe("granted");
    });

    it("maps a prompt permission to lapsed, not an error", async () => {
      // This is the expected state at the start of every browser session.
      const handle = withPermission(makeVault().root, "prompt");
      expect(await readStatus(handle)).toBe("lapsed");
    });

    it("maps a denied permission to denied", async () => {
      const handle = withPermission(makeVault().root, "denied");
      expect(await readStatus(handle)).toBe("denied");
    });

    it("reports a vanished folder as missing", async () => {
      const notFound: Error & { name?: string } = new Error("gone");
      notFound.name = "NotFoundError";
      const handle = {
        queryPermission: async () => "granted" as PermissionState,
        entries: () => ({
          next: async () => {
            throw notFound;
          },
        }),
      } as unknown as FileSystemDirectoryHandle;

      expect(await readStatus(handle)).toBe("missing");
    });
  });
});
