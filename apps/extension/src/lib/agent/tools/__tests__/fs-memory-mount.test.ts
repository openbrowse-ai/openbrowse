import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryIndexDb } from "@/lib/memory-db";
import { memoryStore } from "@/lib/memory/store";
import { installFakeOpfs, type FakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";
import { vfsEvents } from "@/lib/vfs/events";
import { createFsTools } from "../fs";

let fake: FakeOpfs;

beforeEach(() => {
  indexedDB = new IDBFactory();
  memoryIndexDb._resetForTests();
  fake = installFakeOpfs(vi);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx(spaceId: string | null) {
  return {
    driver: {} as never,
    session: { conversationId: "c1", spaceId },
  } as never;
}

const MEMORY_DOC =
  "---\ntitle: Garry Tan\ndescription: CEO of YC\n---\n\n# Compiled truth\n\nRuns [[y-combinator]].\n\n# Timeline\n";

/** Collect `vfs:change` emits for one path while `fn` runs. */
async function captureVfsChanges(
  path: string,
  fn: () => Promise<unknown>,
): Promise<number> {
  let count = 0;
  const onChange = (e: Event) => {
    if ((e as CustomEvent<{ path: string }>).detail.path === path) count += 1;
  };
  vfsEvents.addEventListener("vfs:change", onChange);
  try {
    await fn();
  } finally {
    vfsEvents.removeEventListener("vfs:change", onChange);
  }
  return count;
}

describe("fs tools — memory mount", () => {
  it("Write lands a global memory file and indexes it", async () => {
    const { writeTool } = createFsTools();
    const res = await writeTool.execute(
      { file_path: "memory/garry-tan.md", content: MEMORY_DOC },
      ctx(null),
    );
    expect(res).toMatch(/created/i);
    expect([...fake.files.keys()]).toContain("memory/garry-tan.md");

    const row = await memoryStore.get("memory/garry-tan.md");
    expect(row?.slug).toBe("garry-tan");
    expect(row?.title).toBe("Garry Tan");
  });

  it("Write emits vfs:change again after the index row is current", async () => {
    // `OPFS.writeFile` emits before the memory index is reindexed, so UI that
    // renders parsed frontmatter would read the previous row. `syncMemoryIndex`
    // re-emits once the row is current — hence two emits for one write.
    // Subscribers debounce, so this coalesces into a single refresh.
    const { writeTool } = createFsTools();
    const emits = await captureVfsChanges("memory/garry-tan.md", () =>
      writeTool.execute(
        { file_path: "memory/garry-tan.md", content: MEMORY_DOC },
        ctx(null),
      ),
    );
    expect(emits).toBe(2);
  });

  it("Write to a non-memory path emits vfs:change exactly once", async () => {
    const { writeTool } = createFsTools();
    const emits = await captureVfsChanges(
      "conversations/c1/workspace/out.txt",
      () =>
        writeTool.execute({ file_path: "out.txt", content: "x" }, ctx(null)),
    );
    expect(emits).toBe(1);
  });

  it("Write to the active space's memory indexes under the space scope", async () => {
    const { writeTool } = createFsTools();
    await writeTool.execute(
      { file_path: "spaces/sp1/memory/notes.md", content: MEMORY_DOC },
      ctx("sp1"),
    );
    const row = await memoryStore.get("spaces/sp1/memory/notes.md");
    expect(row?.scope).toBe("space");
    expect(row?.spaceId).toBe("sp1");
  });

  it("Write to ANOTHER space's memory is denied", async () => {
    const { writeTool } = createFsTools();
    const res = await writeTool.execute(
      { file_path: "spaces/other/memory/x.md", content: MEMORY_DOC },
      ctx("sp1"),
    );
    expect(res).toMatch(/Permission denied/i);
    expect(fake.files.has("spaces/other/memory/x.md")).toBe(false);
  });

  it("Read of own memory works; another space's memory is denied", async () => {
    fake.files.set("memory/g.md", new TextEncoder().encode(MEMORY_DOC));
    fake.files.set(
      "spaces/other/memory/s.md",
      new TextEncoder().encode(MEMORY_DOC),
    );
    const { readTool } = createFsTools();
    expect(
      await readTool.execute({ file_path: "memory/g.md" }, ctx("sp1")),
    ).toMatch(/Garry Tan/);
    expect(
      await readTool.execute(
        { file_path: "spaces/other/memory/s.md" },
        ctx("sp1"),
      ),
    ).toMatch(/Permission denied/i);
  });

  it("Move reindexes both paths and preserves the basename slug", async () => {
    const { writeTool, moveTool } = createFsTools();
    await writeTool.execute(
      { file_path: "memory/garry-tan.md", content: MEMORY_DOC },
      ctx(null),
    );
    const res = await moveTool.execute(
      {
        from_path: "memory/garry-tan.md",
        to_path: "memory/people/garry-tan.md",
      },
      ctx(null),
    );
    expect(res).toMatch(/Moved/i);

    // Old index row dropped, new one present with the same slug.
    expect(await memoryStore.get("memory/garry-tan.md")).toBeUndefined();
    const moved = await memoryStore.get("memory/people/garry-tan.md");
    expect(moved?.slug).toBe("garry-tan");
  });

  it("Move out of the memory tree is refused so it can't become an ungated delete", async () => {
    const { writeTool, moveTool } = createFsTools();
    await writeTool.execute(
      { file_path: "memory/garry-tan.md", content: MEMORY_DOC },
      ctx(null),
    );
    const res = await moveTool.execute(
      { from_path: "memory/garry-tan.md", to_path: "notes/garry-tan.md" },
      ctx(null),
    );
    expect(res).toMatch(/memory boundary/i);
    // File and index row both survive the refusal.
    expect(fake.files.has("memory/garry-tan.md")).toBe(true);
    expect(await memoryStore.get("memory/garry-tan.md")).toBeDefined();
  });

  it("Move into the memory tree from the workspace is refused", async () => {
    const { moveTool } = createFsTools();
    fake.files.set("notes/draft.md", new TextEncoder().encode(MEMORY_DOC));
    const res = await moveTool.execute(
      { from_path: "notes/draft.md", to_path: "memory/draft.md" },
      ctx(null),
    );
    expect(res).toMatch(/memory boundary/i);
    // Refused before any bytes moved: the source is still where it was.
    expect(fake.files.has("notes/draft.md")).toBe(true);
    expect(fake.files.has("memory/draft.md")).toBe(false);
  });

  it("Delete removes the memory file and its index row", async () => {
    const { writeTool, deleteTool } = createFsTools();
    await writeTool.execute(
      { file_path: "memory/temp.md", content: MEMORY_DOC },
      ctx(null),
    );
    expect(await memoryStore.get("memory/temp.md")).toBeDefined();

    await deleteTool.execute({ path: "memory/temp.md" }, ctx(null));
    expect(fake.files.has("memory/temp.md")).toBe(false);
    expect(await memoryStore.get("memory/temp.md")).toBeUndefined();
  });

  it("Delete of a memory folder drops the rows beneath it", async () => {
    const { writeTool, deleteTool } = createFsTools();
    await writeTool.execute(
      { file_path: "memory/people/garry-tan.md", content: MEMORY_DOC },
      ctx(null),
    );
    expect(await memoryStore.get("memory/people/garry-tan.md")).toBeDefined();

    await deleteTool.execute({ path: "memory/people" }, ctx(null));
    expect(fake.files.has("memory/people/garry-tan.md")).toBe(false);
    // A deleted *directory* doesn't parse as a memory file, so the index has to
    // clean up by path prefix rather than by row id.
    expect(await memoryStore.get("memory/people/garry-tan.md")).toBeUndefined();
  });

  it("space memory is not visible when no space is active", async () => {
    const { readTool } = createFsTools();
    fake.files.set(
      "spaces/sp1/memory/s.md",
      new TextEncoder().encode(MEMORY_DOC),
    );
    const res = await readTool.execute(
      { file_path: "spaces/sp1/memory/s.md" },
      ctx(null),
    );
    expect(res).toMatch(/Permission denied/i);
  });
});
