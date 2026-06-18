/**
 * Tests for the per-turn "## Workspace files" prompt block.
 *
 * The block is symmetric with the tab legend: it enumerates the
 * conversation's OPFS workspace each turn so the agent sees its own
 * artifacts even after compaction prunes the original tool-result
 * messages. Coverage:
 *   - Empty workspace → no block emitted (don't pollute fresh
 *     conversations with a stray heading).
 *   - Single / multiple files render with size + relative-mtime info.
 *   - Sort: most-recently-modified first.
 *   - .uploads/ subtree excluded (user-attached files, not agent output).
 *   - Truncation when entries exceed the cap.
 *   - Size formatting: bytes / KB / MB / GB.
 *   - Age formatting: just now / Nm / Nh / Nd ago.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildWorkspaceFilesBlock, _internals } from "../workspace-legend";
import { OPFS } from "@/lib/vfs/opfs";

const NOW = new Date("2026-06-18T12:00:00Z").getTime();
const ROOT = "conversations/conv-A/workspace";

interface FakeFile {
  path: string; // absolute (with conversation root prefix)
  size: number;
  lastModified: number;
}

function installOpfsMocks(files: FakeFile[]): void {
  // OPFS.walk is an async generator yielding absolute paths.
  vi.spyOn(OPFS, "walk").mockImplementation(async function* (dirPath: string) {
    for (const f of files) {
      // Mirror real walk(): only yield files under the requested root.
      if (f.path === dirPath || f.path.startsWith(`${dirPath}/`)) {
        yield f.path;
      }
    }
  });
  // OPFS.readFileBytes returns a File-like object with size + lastModified.
  vi.spyOn(OPFS, "readFileBytes").mockImplementation(async (path: string) => {
    const f = files.find((x) => x.path === path);
    if (!f) throw new Error(`no such file: ${path}`);
    // Construct a real File so .size and .lastModified are populated.
    const blob = new Blob([new Uint8Array(f.size)]);
    const file = new File([blob], path.split("/").pop() ?? "x", {
      lastModified: f.lastModified,
    });
    return file;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("buildWorkspaceFilesBlock", () => {
  it("returns empty string when the workspace has no files", async () => {
    installOpfsMocks([]);
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    expect(out).toBe("");
  });

  it("renders a single file with size + age", async () => {
    installOpfsMocks([
      {
        path: `${ROOT}/data.json`,
        size: 12_500,
        lastModified: NOW - 2 * 60_000, // 2m ago
      },
    ]);
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    expect(out).toContain("## Workspace files");
    expect(out).toContain("/workspace contents (1 file):");
    expect(out).toContain("- data.json (12.2 KB, 2m ago)");
    expect(out).toContain("Use the `Read` tool");
  });

  it("renders multiple files sorted most-recently-modified first", async () => {
    installOpfsMocks([
      { path: `${ROOT}/old.txt`, size: 100, lastModified: NOW - 3 * 86_400_000 },
      { path: `${ROOT}/mid.txt`, size: 200, lastModified: NOW - 60_000 },
      { path: `${ROOT}/fresh.txt`, size: 300, lastModified: NOW - 1_000 },
    ]);
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("fresh.txt");
    expect(lines[1]).toContain("mid.txt");
    expect(lines[2]).toContain("old.txt");
  });

  it("excludes .uploads/ files (user-attached, not agent output)", async () => {
    installOpfsMocks([
      { path: `${ROOT}/data.json`, size: 100, lastModified: NOW },
      { path: `${ROOT}/.uploads/photo.png`, size: 5000, lastModified: NOW },
      { path: `${ROOT}/.uploads/sub/doc.pdf`, size: 9000, lastModified: NOW },
    ]);
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    expect(out).toContain("data.json");
    expect(out).not.toContain("photo.png");
    expect(out).not.toContain("doc.pdf");
    expect(out).not.toContain(".uploads");
    expect(out).toContain("(1 file)");
  });

  it("preserves relative paths for files in subdirectories", async () => {
    installOpfsMocks([
      { path: `${ROOT}/sub/dir/inner.json`, size: 100, lastModified: NOW },
    ]);
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    expect(out).toContain("sub/dir/inner.json");
  });

  it("truncates the listing past the entry limit and notes the overflow", async () => {
    const ENTRY_LIMIT = 50;
    const files: FakeFile[] = [];
    for (let i = 0; i < 60; i++) {
      files.push({
        path: `${ROOT}/file-${String(i).padStart(2, "0")}.json`,
        size: 100,
        // ts ascending so the truncation cuts the OLDEST entries (sort is desc).
        lastModified: NOW - i * 1000,
      });
    }
    installOpfsMocks(files);
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    const bulletLines = out.split("\n").filter((l) => l.startsWith("- "));
    // ENTRY_LIMIT visible + 1 "and N more" line = ENTRY_LIMIT + 1.
    expect(bulletLines).toHaveLength(ENTRY_LIMIT + 1);
    expect(bulletLines[bulletLines.length - 1]).toContain("and 10 more");
    // First listed file is the most recent (file-00, mtime closest to NOW).
    expect(bulletLines[0]).toContain("file-00.json");
  });

  it("returns empty when OPFS.walk throws (workspace doesn't exist yet)", async () => {
    vi.spyOn(OPFS, "walk").mockImplementation(async function* () {
      throw new Error("not a directory");
      // unreachable yield to satisfy AsyncGenerator type
      // eslint-disable-next-line no-unreachable
      yield "";
    });
    const out = await buildWorkspaceFilesBlock("conv-A", NOW);
    expect(out).toBe("");
  });
});

describe("formatBytes", () => {
  const f = _internals.formatBytes;
  it("formats bytes / KB / MB / GB", () => {
    expect(f(0)).toBe("0 B");
    expect(f(512)).toBe("512 B");
    expect(f(1024)).toBe("1.0 KB");
    expect(f(12_500)).toBe("12.2 KB");
    expect(f(1024 * 1024)).toBe("1.0 MB");
    expect(f(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(f(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("formatAge", () => {
  const f = _internals.formatAge;
  it("renders coarse relative ages", () => {
    expect(f(NOW, NOW)).toBe("just now");
    expect(f(NOW - 30_000, NOW)).toBe("just now");
    expect(f(NOW - 90_000, NOW)).toBe("1m ago");
    expect(f(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(f(NOW - 90 * 60_000, NOW)).toBe("1h ago");
    expect(f(NOW - 25 * 3_600_000, NOW)).toBe("1d ago");
    // Future timestamps clamp to "just now" rather than a negative value.
    expect(f(NOW + 5_000, NOW)).toBe("just now");
  });
});
