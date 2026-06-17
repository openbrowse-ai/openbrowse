import { describe, it, expect, beforeEach, vi } from "vitest";
import { _internals, persistReturnValue } from "../save-as";
import { OPFS } from "@/lib/vfs/opfs";

const { resolveSaveAsPath } = _internals;

describe("resolveSaveAsPath", () => {
  it("accepts a plain relative path", () => {
    const r = resolveSaveAsPath("conv-1", "data.json");
    expect(r).toEqual({ ok: true, fullPath: "conversations/conv-1/workspace/data.json" });
  });

  it("accepts a /workspace-prefixed path", () => {
    const r = resolveSaveAsPath("conv-1", "/workspace/sub/x.csv");
    expect(r).toEqual({ ok: true, fullPath: "conversations/conv-1/workspace/sub/x.csv" });
  });

  it("rejects an absolute path that doesn't target /workspace", () => {
    const r = resolveSaveAsPath("conv-1", "/etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects /skills writes (read-only)", () => {
    const r = resolveSaveAsPath("conv-1", "/skills/foo.md");
    expect(r.ok).toBe(false);
  });

  it("rejects empty / blank paths", () => {
    expect(resolveSaveAsPath("conv-1", "").ok).toBe(false);
    expect(resolveSaveAsPath("conv-1", "   ").ok).toBe(false);
    expect(resolveSaveAsPath("conv-1", "/workspace/").ok).toBe(false);
  });

  it("rejects `..` traversal", () => {
    expect(resolveSaveAsPath("conv-1", "../escape.txt").ok).toBe(false);
    expect(resolveSaveAsPath("conv-1", "sub/../escape.txt").ok).toBe(false);
    expect(resolveSaveAsPath("conv-1", "a//b.txt").ok).toBe(false);
  });

  it("rejects writes to /.uploads/ (read-only attachments)", () => {
    const r = resolveSaveAsPath("conv-1", ".uploads/foo.png");
    expect(r.ok).toBe(false);
  });
});

describe("persistReturnValue", () => {
  let writes: { path: string; content: string | Uint8Array }[];

  beforeEach(() => {
    writes = [];
    vi.spyOn(OPFS, "writeFileAtomic").mockImplementation(
      async (path: string, content: string) => {
        writes.push({ path, content });
      },
    );
    vi.spyOn(OPFS, "writeFileBytesAtomic").mockImplementation(
      async (path: string, content: Blob | ArrayBuffer | Uint8Array) => {
        if (content instanceof Uint8Array) {
          writes.push({ path, content });
        } else if (content instanceof ArrayBuffer) {
          writes.push({ path, content: new Uint8Array(content) });
        } else {
          // Blob — not used in our tests but handle for completeness.
          writes.push({ path, content: new Uint8Array(await content.arrayBuffer()) });
        }
      },
    );
    // crypto.subtle.digest is fine in Node 20+; no stub needed.
  });

  it("writes a string to the resolved path and returns metadata", async () => {
    const r = await persistReturnValue({
      conversationId: "conv-A",
      saveAs: "out.json",
      returnValue: '{"hello":"world"}',
      source: "executeOnPage",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe("out.json");
      expect(r.bytes).toBe(17);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(writes).toEqual([
      { path: "conversations/conv-A/workspace/out.json", content: '{"hello":"world"}' },
    ]);
  });

  it("decodes a base64 binary envelope and writes bytes", async () => {
    // "hello" base64 = "aGVsbG8="
    const r = await persistReturnValue({
      conversationId: "conv-A",
      saveAs: "blob.bin",
      returnValue: { __binary_b64: "aGVsbG8=" },
      source: "executeOnPage",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes).toBe(5);
    }
    expect(writes.length).toBe(1);
    const written = writes[0].content as Uint8Array;
    expect(new TextDecoder().decode(written)).toBe("hello");
  });

  it("rejects non-string, non-binary return values", async () => {
    const cases: unknown[] = [
      { foo: "bar" },
      42,
      null,
      [1, 2, 3],
      undefined,
      true,
    ];
    for (const v of cases) {
      const r = await persistReturnValue({
        conversationId: "conv-A",
        saveAs: "x.txt",
        returnValue: v,
        source: "executeOnPage",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/script return value must be/);
    }
    expect(writes).toEqual([]);
  });

  it("rejects malformed base64", async () => {
    const r = await persistReturnValue({
      conversationId: "conv-A",
      saveAs: "x.bin",
      returnValue: { __binary_b64: "!!!not-base64!!!" },
      source: "executeOnPage",
    });
    expect(r.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("rejects path traversal attempts before any write", async () => {
    const r = await persistReturnValue({
      conversationId: "conv-A",
      saveAs: "../escape.txt",
      returnValue: "x",
      source: "executeOnPage",
    });
    expect(r.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("accepts Uint8Array directly (executeCode path)", async () => {
    const r = await persistReturnValue({
      conversationId: "conv-A",
      saveAs: "blob.bin",
      returnValue: new Uint8Array([1, 2, 3]),
      source: "executeCode",
    });
    expect(r.ok).toBe(true);
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0].content as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("writes to the conversation-scoped workspace, not a sibling's", async () => {
    // Subagent regression: tools are reused across parent/child agents,
    // and ctx.session.conversationId is the child's id at call time.
    // persistReturnValue must respect that — the child's saveAs must NOT
    // land under the parent's conversation root.
    await persistReturnValue({
      conversationId: "child-conv",
      saveAs: "out.txt",
      returnValue: "child data",
      source: "executeOnPage",
    });
    await persistReturnValue({
      conversationId: "parent-conv",
      saveAs: "out.txt",
      returnValue: "parent data",
      source: "executeOnPage",
    });
    expect(writes).toEqual([
      { path: "conversations/child-conv/workspace/out.txt", content: "child data" },
      { path: "conversations/parent-conv/workspace/out.txt", content: "parent data" },
    ]);
  });

  it("creates nested directories implicitly", async () => {
    // OPFS.getFileHandle(path, true) walks parents with create:true; we
    // just need to confirm a path with subdirectories resolves to the
    // expected fully-qualified location and that persistReturnValue
    // doesn't reject it during validation.
    const r = await persistReturnValue({
      conversationId: "conv-A",
      saveAs: "sub/dir/file.json",
      returnValue: '{"ok":true}',
      source: "executeOnPage",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("sub/dir/file.json");
    expect(writes).toEqual([
      { path: "conversations/conv-A/workspace/sub/dir/file.json", content: '{"ok":true}' },
    ]);
  });
});
