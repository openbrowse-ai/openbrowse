import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Attachment } from "../types";

vi.mock("@/lib/vfs/opfs", () => {
  const writes: Array<{ path: string; size: number }> = [];
  return {
    OPFS: {
      writeFileBytes: vi.fn(async (path: string, blob: Blob) => {
        writes.push({ path, size: blob.size });
      }),
      uniquePath: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
    },
    __writes: writes,
  };
});

import { formatAttachments } from "../format-attachments";
// @ts-ignore — exposed by the mock above for assertions
import { __writes } from "@/lib/vfs/opfs";

function fakeFile(
  name: string,
  size: number,
  type = "application/octet-stream",
): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

beforeEach(() => {
  __writes.length = 0;
});

describe("formatAttachments", () => {
  it("returns empty block and no vision files for an empty list", async () => {
    const r = await formatAttachments("conv-1", [], "openai:gpt-4o");
    expect(r.block).toBe("");
    expect(r.visionFiles).toEqual([]);
    expect(__writes).toEqual([]);
  });

  it("writes a non-image attachment and includes its path in the block", async () => {
    const attachments: Attachment[] = [
      { kind: "file", id: "a1", file: fakeFile("report.pdf", 100) },
    ];
    const r = await formatAttachments(
      "conv-1",
      attachments,
      "anthropic:claude-sonnet-4",
    );
    expect(r.block).toBe(
      "\n\n<Attached files>\n- /.uploads/report.pdf\n</Attached files>",
    );
    expect(r.visionFiles).toEqual([]);
    expect(__writes.length).toBe(1);
    expect(__writes[0].path).toContain("/.uploads/report.pdf");
  });

  it("includes a vision file part for a small image on a vision-capable model", async () => {
    const attachments: Attachment[] = [
      {
        kind: "image",
        id: "i1",
        file: fakeFile("shot.png", 1024 * 1024, "image/png"),
        dataUrl: "data:image/png;base64,AAAA",
      },
    ];
    const r = await formatAttachments(
      "conv-1",
      attachments,
      "anthropic:claude-sonnet-4",
    );
    expect(r.block).toContain("- /.uploads/shot.png");
    expect(r.visionFiles).toEqual([
      { mediaType: "image/png", url: "data:image/png;base64,AAAA" },
    ]);
  });

  it("skips the vision part for an oversize image but still writes the file", async () => {
    const attachments: Attachment[] = [
      {
        kind: "image",
        id: "i1",
        file: fakeFile("big.png", 12 * 1024 * 1024, "image/png"),
        dataUrl: "data:image/png;base64,AAAA",
      },
    ];
    // Anthropic cap is 5 MB; 12 MB exceeds it.
    const r = await formatAttachments(
      "conv-1",
      attachments,
      "anthropic:claude-sonnet-4",
    );
    expect(r.visionFiles).toEqual([]);
    expect(r.block).toContain("- /.uploads/big.png");
    expect(__writes.length).toBe(1);
  });

  it("preserves attachment order in both block and vision parts", async () => {
    const attachments: Attachment[] = [
      { kind: "file", id: "a", file: fakeFile("a.csv", 10) },
      {
        kind: "image",
        id: "b",
        file: fakeFile("b.png", 100, "image/png"),
        dataUrl: "data:image/png;base64,B",
      },
      { kind: "file", id: "c", file: fakeFile("c.txt", 10) },
    ];
    const r = await formatAttachments("conv-1", attachments, "openai:gpt-4o");
    expect(r.block).toBe(
      "\n\n<Attached files>\n- /.uploads/a.csv\n- /.uploads/b.png\n- /.uploads/c.txt\n</Attached files>",
    );
    expect(r.visionFiles).toHaveLength(1);
  });
});
