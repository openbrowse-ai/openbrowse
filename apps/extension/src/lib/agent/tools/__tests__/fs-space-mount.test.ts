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
      exists: vi.fn(async (p: string) => {
        if (fs.has(p)) return true;
        for (const k of fs.keys()) {
          if (k.startsWith(p + "/") || k === p) return true;
        }
        return false;
      }),
      readDir: vi.fn(async (p: string) => {
        const entries: string[] = [];
        let dirExists = false;
        for (const [k] of fs) {
          if (k === p) {
            dirExists = true;
          } else if (k.startsWith(p + "/")) {
            dirExists = true;
            entries.push(k.slice(p.length + 1));
          }
        }
        if (!dirExists) {
          throw new Error("Directory not found at " + p);
        }
        return entries;
      }),
      walk: async function* (p: string) {
        for (const [k] of fs) {
          if (k === p || k.startsWith(p + "/")) yield k;
        }
      },
      remove: vi.fn(async (p: string) => {
        fs.delete(p);
      }),
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

  // --- Glob ---
  it("Glob can search the active space's workspace", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/a.md", "hello");
    const { createFsTools } = await import("../fs");
    const { globTool } = createFsTools();
    const result = await globTool.execute(
      { pattern: "*.md", path: "spaces/sp1/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toContain("a.md");
  });

  it("Glob to ANOTHER space's workspace is denied", async () => {
    (OPFS as any).__fs.set("spaces/other/workspace/a.md", "hello");
    const { createFsTools } = await import("../fs");
    const { globTool } = createFsTools();
    const result = await globTool.execute(
      { pattern: "*.md", path: "spaces/other/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  it("Glob with null spaceId is denied for spaces/* paths", async () => {
    const { createFsTools } = await import("../fs");
    const { globTool } = createFsTools();
    const result = await globTool.execute(
      { pattern: "*.md", path: "spaces/sp1/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: null } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  // --- Grep ---
  it("Grep can search the active space's workspace", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/a.md", "findme");
    const { createFsTools } = await import("../fs");
    const { grepTool } = createFsTools();
    const result = await grepTool.execute(
      { pattern: "findme", path: "spaces/sp1/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toContain("findme");
  });

  it("Grep to ANOTHER space's workspace is denied", async () => {
    (OPFS as any).__fs.set("spaces/other/workspace/a.md", "findme");
    const { createFsTools } = await import("../fs");
    const { grepTool } = createFsTools();
    const result = await grepTool.execute(
      { pattern: "findme", path: "spaces/other/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  it("Grep with null spaceId is denied for spaces/* paths", async () => {
    const { createFsTools } = await import("../fs");
    const { grepTool } = createFsTools();
    const result = await grepTool.execute(
      { pattern: "findme", path: "spaces/sp1/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: null } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  // --- LS ---
  it("LS can list the active space's workspace", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/a.md", "");
    const { createFsTools } = await import("../fs");
    const { lsTool } = createFsTools();
    const result = await lsTool.execute(
      { path: "spaces/sp1/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toContain("a.md");
  });

  it("LS to ANOTHER space's workspace is denied", async () => {
    const { createFsTools } = await import("../fs");
    const { lsTool } = createFsTools();
    const result = await lsTool.execute(
      { path: "spaces/other/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  it("LS with null spaceId is denied for spaces/* paths", async () => {
    const { createFsTools } = await import("../fs");
    const { lsTool } = createFsTools();
    const result = await lsTool.execute(
      { path: "spaces/sp1/workspace" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: null } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  // --- Delete ---
  it("Delete in the active space's workspace is denied (shared workspace is read-only for agent destructive ops)", async () => {
    (OPFS as any).__fs.set("spaces/sp1/workspace/bad.md", "");
    const { createFsTools } = await import("../fs");
    const { deleteTool } = createFsTools();
    const result = await deleteTool.execute(
      { path: "spaces/sp1/workspace/bad.md" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  it("Delete in ANOTHER space's workspace is denied", async () => {
    const { createFsTools } = await import("../fs");
    const { deleteTool } = createFsTools();
    const result = await deleteTool.execute(
      { path: "spaces/other/workspace/bad.md" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: "sp1" } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });

  it("Delete with null spaceId is denied for spaces/* paths", async () => {
    const { createFsTools } = await import("../fs");
    const { deleteTool } = createFsTools();
    const result = await deleteTool.execute(
      { path: "spaces/sp1/workspace/bad.md" },
      { driver: {} as any, session: { conversationId: "c1", spaceId: null } } as any,
    );
    expect(result).toMatch(/Permission denied|not allowed/i);
  });
});
