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
}
