import { describe, expect, it, vi, beforeEach } from "vitest";
import { OPFS } from "@/lib/vfs/opfs";

vi.mock("@/lib/vfs/opfs", () => {
  const fs = new Map<string, string>();
  return {
    OPFS: {
      readFile: vi.fn(async (p: string) => {
        if (!fs.has(p)) throw new Error("not found");
        return fs.get(p)!;
      }),
      writeFile: vi.fn(async (p: string, c: string) => {
        fs.set(p, c);
      }),
      exists: vi.fn(async (p: string) => fs.has(p)),
      readDir: vi.fn(async () => []),
      __fs: fs,
    },
  };
});

beforeEach(() => {
  (OPFS as any).__fs.clear();
});

describe("fs tools — shared space workspace mount", () => {
  it("Read can read spaces/<id>/workspace/<file> when spaceId is set", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/notes.md", "hello");
    const { createFsTools } = await import("../fs");
    const { readTool } = createFsTools();
    const result = await readTool.execute(
      { file_path: "spaces/sp1/workspace/notes.md" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toContain("hello");
  });

  it("Write to the active space's workspace succeeds (approval is gated separately in agent-transport)", async () => {
    const { createFsTools } = await import("../fs");
    const { writeTool } = createFsTools();
    const result = await writeTool.execute(
      { file_path: "spaces/sp1/workspace/notes.md", content: "x" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/created|updated/i);
    expect((OPFS as any).__fs.get("spaces/sp1/workspace/notes.md")).toBe("x");
  });

  it("Write to ANOTHER space's workspace is denied (cross-space)", async () => {
    const { createFsTools } = await import("../fs");
    const { writeTool } = createFsTools();
    const result = await writeTool.execute(
      { file_path: "spaces/other/workspace/notes.md", content: "x" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied/i);
    expect((OPFS as any).__fs.has("spaces/other/workspace/notes.md")).toBe(false);
  });

  it("Edit to the active space's workspace succeeds (approval gated in transport)", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/notes.md", "hello");
    const { createFsTools } = await import("../fs");
    const { editTool } = createFsTools();
    const result = await editTool.execute(
      { file_path: "spaces/sp1/workspace/notes.md", oldString: "hello", newString: "x" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/edited/i);
    expect((OPFS as any).__fs.get("spaces/sp1/workspace/notes.md")).toBe("x");
  });

  it("Edit to ANOTHER space's workspace is denied (cross-space)", async () => {
    (OPFS as any).__fs.set("spaces/other/workspace/notes.md", "hello");
    const { createFsTools } = await import("../fs");
    const { editTool } = createFsTools();
    const result = await editTool.execute(
      { file_path: "spaces/other/workspace/notes.md", oldString: "hello", newString: "x" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied/i);
  });

  it("Reading another space's path when spaceId mismatches is denied", async () => {
    (OPFS as any).__fs.set("spaces/other/workspace/secret.md", "nope");
    const { createFsTools } = await import("../fs");
    const { readTool } = createFsTools();
    const result = await readTool.execute(
      { file_path: "spaces/other/workspace/secret.md" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied|not found|not allowed/i);
  });

  it("With null spaceId, paths under spaces/* are not accessible", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/notes.md", "hello");
    const { createFsTools } = await import("../fs");
    const { readTool } = createFsTools();
    const result = await readTool.execute(
      { file_path: "spaces/sp1/workspace/notes.md" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: null } } as any,
    );
    expect(result).toMatch(/Permission denied|not found|not allowed/i);
  });
});
