import { describe, it, expect, beforeEach, vi } from "vitest";
import { OPFS } from "../opfs";

/**
 * In-memory fake of the small slice of OPFS we use:
 * - getDirectoryHandle({ create }) -> nested fake dirs
 * - getFileHandle({ create }) -> fake file with createWritable()
 * - createWritable() -> a writer that buffers chunks; close() commits.
 * - removeEntry(name) -> deletes file or empty dir.
 *
 * We track the "filesystem state" in a single Map keyed by full path.
 */
function makeFakeOPFS() {
  const files = new Map<string, Uint8Array>();
  // Track which writes are currently in-flight per path so we can simulate
  // close() failures.
  const closeFailures = new Map<string, () => void>();

  function makeDir(prefix: string): FileSystemDirectoryHandle {
    const dir = {
      kind: "directory" as const,
      name: prefix.split("/").pop() || "",
      async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        const fullPrefix = prefix ? `${prefix}/${name}` : name;
        // For simplicity, directories are implicit — we don't track them
        // separately. `create` is a no-op because file paths create their
        // parent chain automatically.
        void opts;
        return makeDir(fullPrefix);
      },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        const fullPath = prefix ? `${prefix}/${name}` : name;
        if (!files.has(fullPath) && !opts?.create) {
          const err: Error & { name?: string } = new Error("not found");
          err.name = "NotFoundError";
          throw err;
        }
        if (!files.has(fullPath)) files.set(fullPath, new Uint8Array());
        return makeFile(fullPath);
      },
      async removeEntry(name: string, _opts?: { recursive?: boolean }) {
        const fullPath = prefix ? `${prefix}/${name}` : name;
        if (files.has(fullPath)) {
          files.delete(fullPath);
          return;
        }
        // Removing a "directory" — delete all files under that prefix.
        const dirPrefix = `${fullPath}/`;
        let removed = false;
        for (const k of [...files.keys()]) {
          if (k.startsWith(dirPrefix)) {
            files.delete(k);
            removed = true;
          }
        }
        if (!removed) {
          const err: Error & { name?: string } = new Error("not found");
          err.name = "NotFoundError";
          throw err;
        }
      },
      async *entries() {
        const dirPrefix = prefix ? `${prefix}/` : "";
        const seen = new Set<string>();
        for (const k of files.keys()) {
          if (!k.startsWith(dirPrefix)) continue;
          const rest = k.slice(dirPrefix.length);
          const next = rest.split("/")[0];
          if (seen.has(next)) continue;
          seen.add(next);
          if (rest.includes("/")) {
            yield [next, makeDir(`${prefix}/${next}`)] as const;
          } else {
            yield [next, makeFile(k)] as const;
          }
        }
      },
    };
    return dir as unknown as FileSystemDirectoryHandle;
  }

  function makeFile(path: string): FileSystemFileHandle {
    const handle = {
      kind: "file" as const,
      name: path.split("/").pop() || "",
      async getFile() {
        const bytes = files.get(path) || new Uint8Array();
        // Cast to BlobPart — DOM lib's typing of Uint8Array<ArrayBufferLike>
        // is overly strict for our test code where the underlying buffer is
        // always a regular ArrayBuffer.
        const blob = new Blob([bytes as BlobPart]);
        // Augment Blob to look like File enough for our reads.
        return Object.assign(blob, {
          name: handle.name,
          lastModified: Date.now(),
        }) as unknown as File;
      },
      async createWritable() {
        // Truncate on open, like the real OPFS default.
        files.set(path, new Uint8Array());
        const chunks: Uint8Array[] = [];
        return {
          async write(chunk: string | ArrayBuffer | Uint8Array | Blob) {
            const bytes = await toBytes(chunk);
            chunks.push(bytes);
          },
          async close() {
            const fail = closeFailures.get(path);
            if (fail) {
              closeFailures.delete(path);
              fail();
            }
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              merged.set(c, off);
              off += c.length;
            }
            files.set(path, merged);
          },
          async abort() {
            chunks.length = 0;
          },
        };
      },
    };
    return handle as unknown as FileSystemFileHandle;
  }

  async function toBytes(
    chunk: string | ArrayBuffer | Uint8Array | Blob,
  ): Promise<Uint8Array> {
    if (typeof chunk === "string") return new TextEncoder().encode(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
    throw new Error("unsupported chunk type");
  }

  const root = makeDir("");
  return {
    root,
    files,
    /** Schedule a one-shot close()-time failure for the given path. */
    failNextCloseAt(path: string, err: Error) {
      closeFailures.set(path, () => {
        throw err;
      });
    },
  };
}

describe("OPFS.writeFileAtomic", () => {
  let fake: ReturnType<typeof makeFakeOPFS>;

  beforeEach(() => {
    fake = makeFakeOPFS();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => fake.root },
    });
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = i;
        return a;
      },
    });
  });

  it("writes content to the destination on success", async () => {
    await OPFS.writeFileAtomic("conv-1/workspace/data.json", '{"a":1}');
    expect(decodeFile(fake, "conv-1/workspace/data.json")).toBe('{"a":1}');
  });

  it("removes the tmp sibling on success", async () => {
    await OPFS.writeFileAtomic("conv-1/workspace/data.json", '{"a":1}');
    const tmpPaths = [...fake.files.keys()].filter((k) => k.includes(".tmp-"));
    expect(tmpPaths).toEqual([]);
  });

  it("does not touch destination if tmp write fails", async () => {
    // Pre-populate destination so we can verify it's preserved.
    await OPFS.writeFileAtomic("conv-1/workspace/data.json", "ORIGINAL");
    const tmpPath = "conv-1/workspace/data.json.tmp-0001020304050607";
    fake.failNextCloseAt(
      tmpPath,
      Object.assign(new Error("simulated tmp close failure"), {
        name: "InvalidStateError",
      }),
    );
    await expect(
      OPFS.writeFileAtomic("conv-1/workspace/data.json", "NEW"),
    ).rejects.toThrow(/simulated tmp close failure/);
    expect(decodeFile(fake, "conv-1/workspace/data.json")).toBe("ORIGINAL");
    // Tmp should be cleaned up after a tmp-write failure.
    const tmpPaths = [...fake.files.keys()].filter((k) => k.includes(".tmp-"));
    expect(tmpPaths).toEqual([]);
  });

  it("preserves tmp file when destination overwrite fails", async () => {
    await OPFS.writeFileAtomic("conv-1/workspace/data.json", "ORIGINAL");
    fake.failNextCloseAt(
      "conv-1/workspace/data.json",
      Object.assign(new Error("simulated final close failure"), {
        name: "InvalidStateError",
      }),
    );
    await expect(
      OPFS.writeFileAtomic("conv-1/workspace/data.json", "NEW"),
    ).rejects.toThrow(/destination write failed; tmp left at/);
    // Tmp must still hold NEW so the caller can recover it.
    const tmpPaths = [...fake.files.keys()].filter((k) => k.includes(".tmp-"));
    expect(tmpPaths.length).toBe(1);
    expect(decodeFile(fake, tmpPaths[0])).toBe("NEW");
  });
});

describe("OPFS.writeFileBytesAtomic", () => {
  let fake: ReturnType<typeof makeFakeOPFS>;

  beforeEach(() => {
    fake = makeFakeOPFS();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => fake.root },
    });
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = i;
        return a;
      },
    });
  });

  it("writes raw bytes to the destination", async () => {
    const payload = new Uint8Array([0xff, 0x00, 0x42, 0xab]);
    await OPFS.writeFileBytesAtomic("conv-1/workspace/blob.bin", payload);
    const stored = fake.files.get("conv-1/workspace/blob.bin")!;
    expect(Array.from(stored)).toEqual([0xff, 0x00, 0x42, 0xab]);
  });

  it("removes tmp on success for binary writes", async () => {
    await OPFS.writeFileBytesAtomic(
      "conv-1/workspace/blob.bin",
      new Uint8Array([1, 2, 3]),
    );
    const tmpPaths = [...fake.files.keys()].filter((k) => k.includes(".tmp-"));
    expect(tmpPaths).toEqual([]);
  });
});

function decodeFile(
  fake: ReturnType<typeof makeFakeOPFS>,
  path: string,
): string {
  const bytes = fake.files.get(path);
  if (!bytes) throw new Error(`no file at ${path}`);
  return new TextDecoder().decode(bytes);
}
