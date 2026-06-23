import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/vfs/opfs", () => {
  const fs = new Map<string, Uint8Array>();
  return {
    OPFS: {
      readFileBytes: vi.fn(async (p: string) => {
        const v = fs.get(p);
        if (v == null) throw new Error("not found");
        // Mimic the real return type — a Blob/File-shaped object.
        // Slice to a fresh ArrayBuffer to satisfy strict BlobPart typing.
        const ab = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
        return new Blob([ab]);
      }),
      writeFileBytes: vi.fn(async (p: string, content: Blob | Uint8Array | ArrayBuffer) => {
        let bytes: Uint8Array;
        if (content instanceof Blob) {
          bytes = new Uint8Array(await content.arrayBuffer());
        } else if (content instanceof ArrayBuffer) {
          bytes = new Uint8Array(content);
        } else {
          bytes = content;
        }
        fs.set(p, bytes);
      }),
      exists: vi.fn(async (p: string) => fs.has(p)),
      __fs: fs,
    },
  };
});

import { OPFS } from "@/lib/vfs/opfs";
import { saveToSpace } from "../save-to-space";
import { savedFilesDb } from "../saved-files-db";

beforeEach(() => {
  (OPFS as any).__fs.clear();
  // Each test gets a clean IDB. Reset the cached handle so the next
  // openDB call sees the fresh factory.
  indexedDB = new IDBFactory();
  savedFilesDb._resetForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("saveToSpace", () => {
  it("copies a top-level file into the space's shared workspace", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("hello"),
    );
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "notes.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedAt).toBe("spaces/sp1/workspace/notes.md");
    expect(result.mode).toBe("created");
    expect((OPFS as any).__fs.has("spaces/sp1/workspace/notes.md")).toBe(true);
  });

  it("copies a nested file preserving its directory structure", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/sub/dir/data.csv",
      new TextEncoder().encode("a,b\n1,2"),
    );
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "sub/dir/data.csv",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedAt).toBe("spaces/sp1/workspace/sub/dir/data.csv");
    expect(result.mode).toBe("created");
  });

  it("re-saving the same source overwrites the same destination (no duplicates)", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("v1"),
    );
    const first = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "notes.md",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.mode).toBe("created");

    // Source changes; user re-saves.
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("v2"),
    );
    const second = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "notes.md",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.mode).toBe("updated");
    expect(second.savedAt).toBe("spaces/sp1/workspace/notes.md");
    // Destination contains the new bytes; no `notes (2).md` was created.
    expect(
      new TextDecoder().decode(
        (OPFS as any).__fs.get("spaces/sp1/workspace/notes.md"),
      ),
    ).toBe("v2");
    expect((OPFS as any).__fs.has("spaces/sp1/workspace/notes (2).md")).toBe(
      false,
    );
  });

  it("records (sourceSize, sourceHashHex, savedAt) so getStatus can detect stale", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("hello"),
    );
    const before = Date.now();
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "notes.md",
    });
    expect(result.ok).toBe(true);

    const record = await savedFilesDb.get("c1", "notes.md");
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.spaceId).toBe("sp1");
    expect(record.spaceFilePath).toBe("notes.md");
    expect(record.sourceSize).toBe(5); // "hello"
    expect(record.sourceHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(record.savedAt).toBeGreaterThanOrEqual(before);
  });

  it("returns ok:false when source does not exist", async () => {
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "missing.md",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("returns ok:false when spaceId is empty", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("x"),
    );
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "",
      filePath: "notes.md",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no active space/i);
  });

  it("strips a leading slash from filePath", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("hello"),
    );
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "/notes.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedAt).toBe("spaces/sp1/workspace/notes.md");
  });

  it("returns ok:false when filePath contains traversal segments", async () => {
    (OPFS as any).__fs.set(
      "conversations/c1/workspace/notes.md",
      new TextEncoder().encode("hello"),
    );
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "../../escape.md",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/\.\.|segment/i);
  });

  it("returns ok:false when filePath contains a current-dir or empty segment", async () => {
    const result = await saveToSpace({
      conversationId: "c1",
      spaceId: "sp1",
      filePath: "sub//file.md",
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when conversationId is empty", async () => {
    const result = await saveToSpace({
      conversationId: "",
      spaceId: "sp1",
      filePath: "notes.md",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/conversation/i);
  });
});
