import { emitVfsChange } from "./events";

export class OPFS {
  /**
   * Resolves a path to a directory handle.
   */
  private static async getDirHandle(
    path: string,
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    // Normalize path by removing leading/trailing slashes
    const cleanPath = path.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) return root;

    const parts = cleanPath.split("/");
    let currentHandle = root;

    for (const part of parts) {
      currentHandle = await currentHandle.getDirectoryHandle(part, { create });
    }
    return currentHandle;
  }

  /**
   * Resolves a path to a file handle.
   */
  private static async getFileHandle(
    path: string,
    create = false,
  ): Promise<FileSystemFileHandle> {
    const cleanPath = path.replace(/^\/+/, "");
    const parts = cleanPath.split("/");
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid file path: " + path);

    const dirPath = parts.join("/");
    const dirHandle = await this.getDirHandle(dirPath, create);

    return await dirHandle.getFileHandle(fileName, { create });
  }

  static async readFile(path: string): Promise<string> {
    const handle = await this.getFileHandle(path);
    const file = await handle.getFile();
    return await file.text();
  }

  /**
   * Read a file as raw bytes (a `Blob`/`File`). Use this for binary content
   * that must not be UTF-8 decoded (PDFs, images, archives, etc.). The
   * returned `File` is itself a `Blob`; convert via `arrayBuffer()` /
   * `bytes()` when you need a `Uint8Array`, or feed straight to
   * `URL.createObjectURL` for inline rendering.
   */
  static async readFileBytes(path: string): Promise<File> {
    const handle = await this.getFileHandle(path);
    return await handle.getFile();
  }

  static async writeFile(path: string, content: string): Promise<void> {
    const handle = await this.getFileHandle(path, true);
    // @ts-ignore
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    emitVfsChange(path);
  }

  /**
   * Write raw bytes to a file. The underlying `FileSystemWritableFileStream`
   * accepts `Blob | ArrayBuffer | Uint8Array` directly, so no intermediate
   * string round-trip is required.
   */
  static async writeFileBytes(
    path: string,
    content: Blob | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const handle = await this.getFileHandle(path, true);
    // @ts-ignore
    const writable = await handle.createWritable();
    // @ts-ignore -- DOM lib types FileSystemWriteChunkType using a non-generic
    // ArrayBufferView, but our Uint8Array carries an ArrayBufferLike generic.
    // The runtime accepts all of these.
    await writable.write(content);
    await writable.close();
    emitVfsChange(path);
  }

  static async readDir(path: string): Promise<string[]> {
    const handle = await this.getDirHandle(path);
    const entries: string[] = [];
    // @ts-ignore
    for await (const [name, entryHandle] of handle.entries()) {
      entries.push(entryHandle.kind === "directory" ? `${name}/` : name);
    }
    return entries;
  }

  static async mkdir(path: string): Promise<void> {
    await this.getDirHandle(path, true);
    emitVfsChange(path);
  }

  static async exists(path: string): Promise<boolean> {
    const cleanPath = path.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) return true;

    const parts = cleanPath.split("/");
    const name = parts.pop();
    if (!name) return true;

    const dirPath = parts.join("/");
    try {
      const dirHandle = await this.getDirHandle(dirPath);
      try {
        await dirHandle.getFileHandle(name);
        return true;
      } catch (e) {
        await dirHandle.getDirectoryHandle(name);
        return true;
      }
    } catch (e) {
      return false;
    }
  }

  static async rm(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const cleanPath = path.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) throw new Error("Cannot remove root directory");

    const parts = cleanPath.split("/");
    const name = parts.pop();
    if (!name) return;

    try {
      const dirPath = parts.join("/");
      const dirHandle = await this.getDirHandle(dirPath);
      await dirHandle.removeEntry(name, options);
      emitVfsChange(path);
    } catch (e: any) {
      if (e.name === "NotFoundError") {
        // Ignore if the file or directory doesn't exist
        return;
      }
      throw e;
    }
  }

  /**
   * Helper to recursively walk a directory and yield all file paths.
   */
  static async *walk(dirPath: string): AsyncGenerator<string> {
    const cleanPath = dirPath.replace(/^\/+|\/+$/g, "");
    let handle;
    try {
      handle = await this.getDirHandle(cleanPath);
    } catch (e) {
      return; // Directory doesn't exist
    }

    // @ts-ignore
    for await (const [name, entryHandle] of handle.entries()) {
      const fullPath = cleanPath ? `${cleanPath}/${name}` : name;
      if (entryHandle.kind === "directory") {
        yield* this.walk(fullPath);
      } else {
        yield fullPath;
      }
    }
  }

  /**
   * Resolve a non-colliding filename inside `dirPath`. Creates the
   * directory if it doesn't exist (so callers can race with first
   * write to a fresh workspace). Returns the absolute path the caller
   * can pass to `writeFileBytes`.
   *
   * NOTE: Name resolution and the subsequent `writeFileBytes` are not
   * atomic. Concurrent callers may both resolve the same suffix and the
   * second write will overwrite the first. Callers must serialize
   * uploads into the same directory.
   */
  static async uniquePath(dirPath: string, filename: string): Promise<string> {
    const dir = await this.getDirHandle(dirPath, true);
    const unique = await uniqueNameInDir(dir, filename);
    const cleanDir = dirPath.replace(/^\/+|\/+$/g, "");
    return cleanDir ? `${cleanDir}/${unique}` : unique;
  }
}

/**
 * Given a directory handle and a desired filename, return a name that
 * doesn't collide with any existing file or subdirectory in the dir,
 * by Finder-style suffixing the basename: `report.pdf` →
 * `report (2).pdf` → `report (3).pdf`, etc. Filenames without an
 * extension (e.g. `README`, `.gitignore`) are suffixed at the end.
 *
 * Exported separately so it can be unit-tested against a fake
 * `FileSystemDirectoryHandle` in environments without real OPFS.
 */
export async function uniqueNameInDir(
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
): Promise<string> {
  const exists = async (name: string): Promise<boolean> => {
    try {
      await dirHandle.getFileHandle(name);
      return true;
    } catch (e: any) {
      if (e?.name !== "NotFoundError") throw e;
    }
    try {
      await dirHandle.getDirectoryHandle(name);
      return true;
    } catch (e: any) {
      if (e?.name !== "NotFoundError") throw e;
    }
    return false;
  };

  if (!(await exists(filename))) return filename;

  // Split on the LAST dot, but only if there's a non-empty stem before it.
  // ".gitignore" has no stem, so it's treated as extensionless.
  const lastDot = filename.lastIndexOf(".");
  const hasExt = lastDot > 0;
  const stem = hasExt ? filename.slice(0, lastDot) : filename;
  const ext = hasExt ? filename.slice(lastDot) : "";

  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  // Pathological — fall back to a timestamp suffix.
  return `${stem} (${Date.now()})${ext}`;
}
