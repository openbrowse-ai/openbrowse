import { describe, it, expect } from "vitest";
import { validateFiles } from "../validate-files";

const MB = 1024 * 1024;

function makeFile(name: string, size: number, type = ""): File {
  // jsdom's File constructor accepts blob parts; pad with a single
  // zero byte so we can override `size` via Object.defineProperty.
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("validateFiles", () => {
  it("accepts files under the cap with no rejections", () => {
    const files = [
      makeFile("a.txt", 1 * MB),
      makeFile("b.png", 2 * MB, "image/png"),
    ];
    const result = validateFiles(files);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejections).toEqual([]);
  });

  it("rejects non-image files larger than fileCap", () => {
    const files = [makeFile("big.bin", 100 * MB)];
    const result = validateFiles(files, { fileCap: 50 * MB });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections[0]).toContain("big.bin");
    expect(result.rejections[0]).toContain("50 MB");
  });

  it("rejects images larger than imageCap and labels them as image", () => {
    const files = [makeFile("photo.png", 25 * MB, "image/png")];
    const result = validateFiles(files, { fileCap: 50 * MB, imageCap: 10 * MB });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections[0]).toContain("photo.png");
    expect(result.rejections[0]).toContain("image limit");
  });

  it("truncates to remaining slots and surfaces a count rejection", () => {
    const files = [
      makeFile("a.txt", 1),
      makeFile("b.txt", 1),
      makeFile("c.txt", 1),
    ];
    const result = validateFiles(files, { countCap: 2 });
    expect(result.accepted).toHaveLength(2);
    expect(result.rejections[0]).toMatch(/Only \d+ more file/);
  });

  it("returns the 'maximum reached' message when no slots remain", () => {
    const result = validateFiles([makeFile("a.txt", 1)], {
      countCap: 5,
      existingCount: 5,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections[0]).toContain("Maximum");
  });

  it("uses provided existingCount to compute remaining slots", () => {
    const files = [
      makeFile("a.txt", 1),
      makeFile("b.txt", 1),
      makeFile("c.txt", 1),
    ];
    const result = validateFiles(files, { countCap: 5, existingCount: 4 });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejections[0]).toMatch(/Only 1 more file allowed/);
  });

  it("uses defaults when no options are passed", () => {
    // 50 MB default fileCap; 10 MB default imageCap; 10 default countCap.
    const files = [makeFile("ok.bin", 49 * MB)];
    expect(validateFiles(files).accepted).toHaveLength(1);

    const tooBigFile = [makeFile("big.bin", 51 * MB)];
    expect(validateFiles(tooBigFile).accepted).toHaveLength(0);

    const tooBigImage = [makeFile("big.png", 12 * MB, "image/png")];
    expect(validateFiles(tooBigImage).accepted).toHaveLength(0);
  });

  it("singular phrasing when exactly one slot remains", () => {
    const files = [makeFile("a.txt", 1), makeFile("b.txt", 1)];
    const result = validateFiles(files, { countCap: 5, existingCount: 4 });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejections[0]).toContain("Only 1 more file allowed");
  });

  it("preserves the order of accepted files", () => {
    const files = [
      makeFile("a.txt", 1),
      makeFile("b.bin", 100 * MB), // rejected
      makeFile("c.txt", 1),
    ];
    const result = validateFiles(files, { fileCap: 50 * MB });
    expect(result.accepted.map((f) => f.name)).toEqual(["a.txt", "c.txt"]);
  });
});
