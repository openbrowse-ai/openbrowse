import { describe, it, expect } from "vitest";
import {
  getTypeBadge,
  isTextFile,
  countLines,
  formatBytes,
} from "../attachment-meta";

describe("getTypeBadge", () => {
  it("returns the uppercased extension for common files", () => {
    expect(getTypeBadge("report.pdf")).toBe("PDF");
    expect(getTypeBadge("notes.md")).toBe("MD");
    expect(getTypeBadge("data.json")).toBe("JSON");
    expect(getTypeBadge("App.tsx")).toBe("TSX");
  });

  it("uses the last segment for multi-dot names", () => {
    expect(getTypeBadge("archive.tar.gz")).toBe("GZ");
  });

  it("returns FILE for extensionless names", () => {
    expect(getTypeBadge("README")).toBe("FILE");
  });

  it("returns FILE for dotfiles", () => {
    expect(getTypeBadge(".gitignore")).toBe("FILE");
  });
});

describe("isTextFile", () => {
  it("returns true for code", () => {
    expect(isTextFile("foo.ts")).toBe(true);
    expect(isTextFile("foo.json")).toBe(true);
    expect(isTextFile("README")).toBe(true); // unknown extensions classify as code
  });

  it("returns true for markdown", () => {
    expect(isTextFile("foo.md")).toBe(true);
  });

  it("returns false for binary classes", () => {
    expect(isTextFile("foo.pdf")).toBe(false);
    expect(isTextFile("foo.png")).toBe(false);
    expect(isTextFile("foo.zip")).toBe(false);
  });
});

describe("countLines", () => {
  it("returns 0 for an empty string", () => {
    expect(countLines("")).toBe(0);
  });

  it("returns 1 for a single line without trailing newline", () => {
    expect(countLines("hello")).toBe(1);
  });

  it("returns 1 for a single line with trailing newline", () => {
    expect(countLines("hello\n")).toBe(1);
  });

  it("counts multiple lines without trailing newline", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  it("counts multiple lines with trailing newline", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  it("counts a lone newline as 1", () => {
    expect(countLines("\n")).toBe(1);
  });
});

describe("formatBytes", () => {
  it("uses bytes under 1 KiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("rounds to whole KB up to 1 MiB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(24 * 1024)).toBe("24 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("uses MB with one decimal above 1 MiB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
    expect(formatBytes(1024 * 1024 * 1.25)).toBe("1.3 MB");
  });
});
