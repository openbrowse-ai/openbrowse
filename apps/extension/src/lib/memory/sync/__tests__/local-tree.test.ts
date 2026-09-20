import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryIndexDb } from "@/lib/memory-db";
import { installFakeOpfs, type FakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";
import { OPFS } from "@/lib/vfs/opfs";
import { serializeMemory, type MemoryDoc } from "../../format";
import { memoryStore } from "../../store";
import { sha256 } from "../hash";
import { createOpfsMemoryTree } from "../local-tree";

let fake: FakeOpfs;

beforeEach(() => {
  indexedDB = new IDBFactory();
  memoryIndexDb._resetForTests();
  fake = installFakeOpfs(vi);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("createOpfsMemoryTree", () => {
  it("lists global memory files with their content hash", async () => {
    const content = doc({ title: "Garry Tan" });
    await OPFS.writeFile("memory/garry-tan.md", content);

    const entries = await createOpfsMemoryTree().list();

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("memory/garry-tan.md");
    expect(entries[0].sha256).toBe(await sha256(content));
    expect(entries[0].size).toBeGreaterThan(0);
  });

  it("excludes space-scoped memory, non-markdown files, and atomic-write leftovers", async () => {
    await OPFS.writeFile("memory/keep.md", doc());
    await OPFS.writeFile("memory/notes.txt", "plain");
    // `writeFileAtomic` leaves this behind when a destination write fails.
    await OPFS.writeFile("memory/keep.md.tmp-abc123", "partial");
    await OPFS.writeFile("spaces/space-1/memory/scoped.md", doc());

    const paths = (await createOpfsMemoryTree().list()).map((e) => e.path);

    expect(paths).toEqual(["memory/keep.md"]);
  });

  it("makes a written file immediately searchable", async () => {
    // This is the property that matters: a pulled file has to enter the derived
    // index, or the agent cannot recall what sync just brought in.
    await createOpfsMemoryTree().write(
      "memory/staging-url.md",
      doc({ title: "Staging URL", truth: "https://staging.example.com" }),
    );

    const { results } = await memoryStore.search("staging url", {
      activeSpaceId: null,
    });
    expect(results.map((r) => r.path)).toEqual(["memory/staging-url.md"]);
  });

  it("drops the index row and link edges when removing a file", async () => {
    const tree = createOpfsMemoryTree();
    await tree.write("memory/a.md", doc({ title: "A", truth: "see [[b]]" }));
    expect(await memoryStore.get("memory/a.md")).toBeDefined();
    expect(await memoryIndexDb.linksBySource("memory/a.md")).toHaveLength(1);

    await tree.remove("memory/a.md");

    expect(await memoryStore.get("memory/a.md")).toBeUndefined();
    expect(await memoryIndexDb.linksBySource("memory/a.md")).toHaveLength(0);
    expect(fake.files.has("memory/a.md")).toBe(false);
  });

  it("round-trips content through read", async () => {
    const content = doc({ title: "Round Trip" });
    const tree = createOpfsMemoryTree();
    await tree.write("memory/round-trip.md", content);
    expect(await tree.read("memory/round-trip.md")).toBe(content);
  });

  describe("refuses to touch anything outside global memory", () => {
    // Defense in depth: the engine validates first, but this is the last line
    // before bytes land in OPFS.
    const forbidden = [
      "memory/../escape.md",
      "spaces/space-1/memory/scoped.md",
      "conversations/1/workspace/notes.md",
      "skills/evil/SKILL.md",
      "memory/notes.txt",
    ];

    for (const path of forbidden) {
      it(`rejects ${path}`, async () => {
        const tree = createOpfsMemoryTree();
        await expect(tree.write(path, "x")).rejects.toThrow(/non-memory path/);
        await expect(tree.read(path)).rejects.toThrow(/non-memory path/);
        await expect(tree.remove(path)).rejects.toThrow(/non-memory path/);
      });
    }

    it("leaves a space-scoped file on disk untouched after a rejected write", async () => {
      const original = doc({ title: "Scoped" });
      await OPFS.writeFile("spaces/space-1/memory/scoped.md", original);

      await expect(
        createOpfsMemoryTree().write(
          "spaces/space-1/memory/scoped.md",
          "clobbered",
        ),
      ).rejects.toThrow();

      expect(await OPFS.readFile("spaces/space-1/memory/scoped.md")).toBe(
        original,
      );
    });
  });
});
