// apps/extension/src/lib/agent/tools/__tests__/create-artifact.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const opfs = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(async () => undefined),
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith("/workspace/x.html")) return "<html><body>hi</body></html>";
    return "";
  }),
  exists: vi.fn(async (p: string) => false),
  readDir: vi.fn(async () => []),
  rm: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("@/lib/vfs/opfs", () => ({ OPFS: opfs }));

import { createArtifactTool } from "../create-artifact";
import type { ToolContext } from "../../driver";

function ctx(conversationId: string | null): ToolContext {
  return { driver: {} as ToolContext["driver"], session: { conversationId, spaceId: null } as any };
}

beforeEach(() => {
  for (const fn of Object.values(opfs)) (fn as { mockReset: () => void }).mockReset();
  opfs.writeFileAtomic.mockResolvedValue(undefined);
  opfs.readFile.mockImplementation(async (p: string) => {
    if (p.endsWith("/workspace/x.html")) return "<html><body>hi</body></html>";
    return "";
  });
  opfs.exists.mockImplementation(async (p: string) => {
    if (p.endsWith("/workspace/x.html")) return true;
    return false;
  });
  opfs.readDir.mockResolvedValue([]);
  opfs.rm.mockResolvedValue(undefined);
});

describe("createArtifactTool", () => {
  it("validates manifest and writes /artifacts/<id>.html + meta", async () => {
    const result = await createArtifactTool.execute({
      id: "linear-triage",
      title: "Linear Triage",
      icon: "🐛",
      html_path: "x.html",
      tools: [{ name: "mcp.linear.search_issues", mode: "read" }],
    }, ctx("conv-A"));
    expect(result.artifactId).toBe("linear-triage");
    expect(result.openUrl).toMatch(/artifact\.html\?id=linear-triage/);
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "artifacts/linear-triage.html",
      expect.stringContaining('"id":"linear-triage"'),
    );
    // Icon is persisted inside the inlined manifest meta tag so it round-trips
    // through loadArtifact alongside the other manifest fields.
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "artifacts/linear-triage.html",
      expect.stringContaining('"icon":"🐛"'),
    );
  });

  it("removes the source workspace file after promoting", async () => {
    await createArtifactTool.execute({
      id: "linear-triage",
      title: "Linear Triage",
      icon: "🐛",
      html_path: "x.html",
      tools: [],
    }, ctx("conv-A"));
    // The authoring scratch file should be removed from the workspace so it
    // doesn't linger in the Working folder as a duplicate of the artifact.
    expect(opfs.rm).toHaveBeenCalledWith(
      "conversations/conv-A/workspace/x.html",
    );
  });

  it("still succeeds if removing the source file fails (best-effort)", async () => {
    opfs.rm.mockRejectedValueOnce(new Error("rm failed"));
    const result = await createArtifactTool.execute({
      id: "linear-triage",
      title: "Linear Triage",
      icon: "🐛",
      html_path: "x.html",
      tools: [],
    }, ctx("conv-A"));
    expect(result.artifactId).toBe("linear-triage");
  });

  it("rejects an invalid id", async () => {
    await expect(createArtifactTool.execute({
      id: "Bad ID",
      title: "x",
      icon: "🐛",
      html_path: "x.html",
      tools: [],
    }, ctx("conv-A"))).rejects.toThrow();
  });

  it("requires a conversation id (workspace context)", async () => {
    await expect(createArtifactTool.execute({
      id: "x",
      title: "x",
      icon: "🐛",
      html_path: "x.html",
      tools: [],
    }, ctx(null))).rejects.toThrow(/conversation/i);
  });

  it("accepts inline html without touching the workspace", async () => {
    const result = await createArtifactTool.execute({
      id: "inline-art",
      title: "Inline Art",
      icon: "📦",
      html: "<html><body>inline</body></html>",
      tools: [],
    }, ctx("conv-A"));
    expect(result.artifactId).toBe("inline-art");
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "artifacts/inline-art.html",
      expect.stringContaining("inline"),
    );
    // Inline html has no scratch file — nothing should be read from or removed
    // from the workspace.
    expect(opfs.rm).not.toHaveBeenCalled();
  });

  describe("parameters schema", () => {
    const schema = createArtifactTool.parameters;
    const base = { id: "x", title: "x", icon: "🐛", tools: [] };

    it("accepts exactly html", () => {
      expect(schema.safeParse({ ...base, html: "<html></html>" }).success).toBe(true);
    });

    it("accepts exactly html_path", () => {
      expect(schema.safeParse({ ...base, html_path: "x.html" }).success).toBe(true);
    });

    it("rejects providing both html and html_path", () => {
      expect(
        schema.safeParse({ ...base, html: "<html></html>", html_path: "x.html" }).success,
      ).toBe(false);
    });

    it("rejects providing neither html nor html_path", () => {
      expect(schema.safeParse({ ...base }).success).toBe(false);
    });

    it("requires icon", () => {
      // The agent must supply an emoji icon for every artifact; the picker in
      // the standalone tab header then lets the user override it later.
      const { icon: _icon, ...withoutIcon } = base;
      expect(
        schema.safeParse({ ...withoutIcon, html: "<html></html>" }).success,
      ).toBe(false);
    });

    it("rejects an empty icon", () => {
      expect(
        schema.safeParse({ ...base, icon: "", html: "<html></html>" }).success,
      ).toBe(false);
    });
  });
});
