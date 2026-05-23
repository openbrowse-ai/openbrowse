import { describe, it, expect } from "vitest";
import { uniqueNameInDir } from "../opfs";

/** Build a fake FileSystemDirectoryHandle that "contains" the given names. */
function fakeDir(existingNames: string[]) {
  return {
    async getFileHandle(name: string) {
      if (existingNames.includes(name)) return {} as FileSystemFileHandle;
      const err: any = new Error("not found");
      err.name = "NotFoundError";
      throw err;
    },
    async getDirectoryHandle(name: string) {
      if (existingNames.includes(name)) return {} as FileSystemDirectoryHandle;
      const err: any = new Error("not found");
      err.name = "NotFoundError";
      throw err;
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe("uniqueNameInDir", () => {
  it("returns the original name if no collision", async () => {
    const dir = fakeDir([]);
    expect(await uniqueNameInDir(dir, "report.pdf")).toBe("report.pdf");
  });

  it("appends ' (2)' before the extension on first collision", async () => {
    const dir = fakeDir(["report.pdf"]);
    expect(await uniqueNameInDir(dir, "report.pdf")).toBe("report (2).pdf");
  });

  it("walks to the next free index", async () => {
    const dir = fakeDir(["report.pdf", "report (2).pdf", "report (3).pdf"]);
    expect(await uniqueNameInDir(dir, "report.pdf")).toBe("report (4).pdf");
  });

  it("handles filenames with no extension", async () => {
    const dir = fakeDir(["README"]);
    expect(await uniqueNameInDir(dir, "README")).toBe("README (2)");
  });

  it("treats dotfiles correctly (no extension swap)", async () => {
    const dir = fakeDir([".gitignore"]);
    expect(await uniqueNameInDir(dir, ".gitignore")).toBe(".gitignore (2)");
  });

  it("only suffixes the last dot for multi-dot names", async () => {
    const dir = fakeDir(["archive.tar.gz"]);
    expect(await uniqueNameInDir(dir, "archive.tar.gz")).toBe(
      "archive.tar (2).gz",
    );
  });

  it("treats a directory name collision the same as a file collision", async () => {
    // If a subdirectory named "data.csv" exists, we still need a unique name.
    const dir = fakeDir([]);
    // Override: only directory exists, not file.
    const customDir = {
      async getFileHandle(_: string) {
        const err: any = new Error("not found");
        err.name = "NotFoundError";
        throw err;
      },
      async getDirectoryHandle(name: string) {
        if (name === "data.csv") return {} as FileSystemDirectoryHandle;
        const err: any = new Error("not found");
        err.name = "NotFoundError";
        throw err;
      },
    } as unknown as FileSystemDirectoryHandle;
    expect(await uniqueNameInDir(customDir, "data.csv")).toBe("data (2).csv");
  });
});
