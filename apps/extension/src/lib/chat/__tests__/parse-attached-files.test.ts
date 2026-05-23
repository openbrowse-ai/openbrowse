import { describe, it, expect, vi } from "vitest";
import { parseAttachedFiles } from "../parse-attached-files";

// Mock OPFS so we can call formatAttachments without a real OPFS env.
vi.mock("@/lib/vfs/opfs", () => ({
  OPFS: {
    writeFileBytes: vi.fn(async () => {}),
    uniquePath: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
  },
}));

import { formatAttachments } from "../format-attachments";
import type { Attachment } from "../types";

function fakeFile(name: string, size = 100, type = "application/octet-stream") {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type });
}

describe("parseAttachedFiles", () => {
  it("returns text unchanged with no block", () => {
    const r = parseAttachedFiles("hello world");
    expect(r.displayText).toBe("hello world");
    expect(r.attachedPaths).toEqual([]);
  });

  it("returns text unchanged when the block is malformed (no closing tag)", () => {
    const text = "hello\n\n<Attached files>\n- /foo.pdf\n";
    const r = parseAttachedFiles(text);
    expect(r.displayText).toBe(text);
    expect(r.attachedPaths).toEqual([]);
  });

  it("strips the block and extracts paths", () => {
    const text =
      "summarize this\n\n<Attached files>\n- /report.pdf\n- /data.csv\n</Attached files>";
    const r = parseAttachedFiles(text);
    expect(r.displayText).toBe("summarize this");
    expect(r.attachedPaths).toEqual(["/report.pdf", "/data.csv"]);
  });

  it("preserves a user-typed `<Attached files>` literal earlier in the body", () => {
    const text =
      "I wrote <Attached files> in my prompt\n\n<Attached files>\n- /real.pdf\n</Attached files>";
    const r = parseAttachedFiles(text);
    expect(r.displayText).toBe("I wrote <Attached files> in my prompt");
    expect(r.attachedPaths).toEqual(["/real.pdf"]);
  });

  it("filters empty lines and trims whitespace", () => {
    const text =
      "x\n\n<Attached files>\n- /a.pdf\n\n-  /b.csv  \n</Attached files>";
    const r = parseAttachedFiles(text);
    expect(r.attachedPaths).toEqual(["/a.pdf", "/b.csv"]);
  });

  it("round-trips with formatAttachments output", async () => {
    const attachments: Attachment[] = [
      { kind: "file", id: "1", file: fakeFile("report.pdf") },
      {
        kind: "image",
        id: "2",
        file: fakeFile("shot.png", 100, "image/png"),
        dataUrl: "data:image/png;base64,A",
      },
      { kind: "file", id: "3", file: fakeFile("data.csv") },
    ];
    const formatted = await formatAttachments(
      "conv-1",
      attachments,
      "openai:gpt-4o",
    );
    const userText = "look at these";
    const combined = userText + formatted.block;

    const parsed = parseAttachedFiles(combined);
    expect(parsed.displayText).toBe(userText);
    expect(parsed.attachedPaths).toEqual([
      "/report.pdf",
      "/shot.png",
      "/data.csv",
    ]);
  });

  it("round-trips empty attachments (no block, no paths)", async () => {
    const formatted = await formatAttachments(
      "conv-1",
      [],
      "openai:gpt-4o",
    );
    const userText = "just text, no files";
    const combined = userText + formatted.block;

    const parsed = parseAttachedFiles(combined);
    expect(parsed.displayText).toBe(userText);
    expect(parsed.attachedPaths).toEqual([]);
  });
});
