import { vi } from "vitest";

/**
 * Install a minimal in-memory OPFS backend for the Node test environment.
 * `OPFS` (src/lib/vfs/opfs.ts) talks to `navigator.storage.getDirectory()`,
 * which doesn't exist under Vitest's `node` env. This shim implements just
 * enough of the FileSystemDirectoryHandle API for OPFS.readFile/writeFile/
 * rm/exists/readDir to work against an in-memory tree.
 *
 * Call from a `beforeAll`. Returns nothing; OPFS just works afterward.
 */
class FakeFile {
  constructor(private data: string) {}
  text() {
    return Promise.resolve(this.data);
  }
}

class FakeWritable {
  private buf = "";
  constructor(private commit: (data: string) => void) {}
  write(chunk: string) {
    this.buf += typeof chunk === "string" ? chunk : String(chunk);
    return Promise.resolve();
  }
  close() {
    this.commit(this.buf);
    return Promise.resolve();
  }
}

class FakeFileHandle {
  readonly kind = "file" as const;
  constructor(
    private dir: FakeDirHandle,
    private fname: string,
  ) {}
  getFile() {
    return Promise.resolve(new FakeFile(this.dir._files.get(this.fname) ?? ""));
  }
  createWritable() {
    return Promise.resolve(
      new FakeWritable((data) => this.dir._files.set(this.fname, data)),
    );
  }
}

function notFound() {
  const e = new Error("NotFoundError");
  e.name = "NotFoundError";
  return e;
}

class FakeDirHandle {
  readonly kind = "directory" as const;
  _files = new Map<string, string>();
  _dirs = new Map<string, FakeDirHandle>();

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this._dirs.get(name);
    if (!d) {
      if (!opts?.create) throw notFound();
      d = new FakeDirHandle();
      this._dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this._files.has(name)) {
      if (!opts?.create) throw notFound();
      this._files.set(name, "");
    }
    return new FakeFileHandle(this, name);
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }) {
    const had = this._files.delete(name) || this._dirs.delete(name);
    if (!had) throw notFound();
  }

  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirHandle]> {
    for (const [name] of this._files)
      yield [name, new FakeFileHandle(this, name)];
    for (const [name, dir] of this._dirs) yield [name, dir];
  }
}

export function installFakeOpfs(): void {
  const root = new FakeDirHandle();
  vi.stubGlobal("navigator", {
    ...(globalThis as { navigator?: object }).navigator,
    storage: { getDirectory: () => Promise.resolve(root) },
  });
}
