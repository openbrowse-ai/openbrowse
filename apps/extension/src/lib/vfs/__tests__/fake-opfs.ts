// src/lib/vfs/__tests__/fake-opfs.ts
//
// Reusable in-memory fake of the small slice of OPFS the extension uses.
// Mirrors the fake in `opfs-atomic.test.ts` but is shared so other suites
// (e.g. the memory store) can exercise real OPFS code paths without a browser.
//
// Not a test file itself (no `.test.ts` suffix) — import `makeFakeOpfs` and
// `installFakeOpfs` from your suite.

export interface FakeOpfs {
  root: FileSystemDirectoryHandle;
  files: Map<string, Uint8Array>;
}

export function makeFakeOpfs(): FakeOpfs {
  const files = new Map<string, Uint8Array>();

  function makeDir(prefix: string): FileSystemDirectoryHandle {
    const dir = {
      kind: "directory" as const,
      name: prefix.split("/").pop() || "",
      async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        const fullPrefix = prefix ? `${prefix}/${name}` : name;
        // A directory "exists" when a file lives at or under its prefix.
        // Without `create`, resolving a nonexistent directory must throw
        // NotFoundError so `OPFS.exists` can distinguish missing paths.
        if (!opts?.create) {
          let present = false;
          for (const k of files.keys()) {
            if (k === fullPrefix || k.startsWith(`${fullPrefix}/`)) {
              present = true;
              break;
            }
          }
          if (!present) {
            const err: Error & { name?: string } = new Error("not found");
            err.name = "NotFoundError";
            throw err;
          }
        }
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
            yield [next, makeDir(prefix ? `${prefix}/${next}` : next)] as const;
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
        const blob = new Blob([bytes as BlobPart]);
        return Object.assign(blob, {
          name: handle.name,
          lastModified: Date.now(),
        }) as unknown as File;
      },
      async createWritable() {
        files.set(path, new Uint8Array());
        const chunks: Uint8Array[] = [];
        return {
          async write(chunk: string | ArrayBuffer | Uint8Array | Blob) {
            chunks.push(await toBytes(chunk));
          },
          async close() {
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

  return { root: makeDir(""), files };
}

/**
 * Stub `navigator.storage.getDirectory()` to serve a fresh in-memory OPFS.
 * Preserves the existing global `crypto` (Node provides `getRandomValues`),
 * which `OPFS.writeFileAtomic` needs for its tmp-file suffix. Pass vitest's
 * `vi` so callers keep control over stub lifetime (`vi.unstubAllGlobals`).
 */
export function installFakeOpfs(vi: {
  stubGlobal: (name: string, value: unknown) => void;
}): FakeOpfs {
  const fake = makeFakeOpfs();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => fake.root },
  });
  return fake;
}
