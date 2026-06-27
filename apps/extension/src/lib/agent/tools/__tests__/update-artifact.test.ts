// apps/extension/src/lib/agent/tools/__tests__/update-artifact.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const EXISTING_HTML =
  `<!doctype html><html><head><meta name="openbrowse:artifact" content='${JSON.stringify({
    v: 1,
    id: "linear-triage",
    title: "Linear Triage",
    tools: [{ name: "mcp.linear.list_issues", mode: "read" }],
  })}'></head><body>OLD</body></html>`;

const EXISTING_META = JSON.stringify({
  id: "linear-triage",
  createdAt: "t",
  updatedAt: "t",
  approvedWrites: [],
  approvedNetwork: [],
  manifestVersion: "v",
});

const opfs = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => undefined),
  readFile: vi.fn(async (_p: string) => ""),
  exists: vi.fn(async (_p: string) => false),
  readDir: vi.fn(async () => [] as string[]),
  rm: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("@/lib/vfs/opfs", () => ({ OPFS: opfs }));

import { updateArtifactTool } from "../update-artifact";
import type { ToolContext } from "../../driver";

function ctx(conversationId: string | null): ToolContext {
  return { driver: {} as ToolContext["driver"], session: { conversationId, spaceId: null } as any };
}

beforeEach(() => {
  for (const fn of Object.values(opfs)) (fn as { mockReset: () => void }).mockReset();
  opfs.writeFileAtomic.mockResolvedValue(undefined);
  opfs.exists.mockImplementation(async (p: string) =>
    p === "artifacts/linear-triage.html" || p === "artifacts/linear-triage.meta.json",
  );
  opfs.readFile.mockImplementation(async (p: string) => {
    if (p === "artifacts/linear-triage.html") return EXISTING_HTML;
    if (p === "artifacts/linear-triage.meta.json") return EXISTING_META;
    return "";
  });
  opfs.readDir.mockResolvedValue([]);
});

function writtenHtml(): string {
  const calls = opfs.writeFileAtomic.mock.calls as unknown as Array<[string, string]>;
  const call = calls.find(([p]) => p === "artifacts/linear-triage.html");
  return call?.[1] ?? "";
}

describe("updateArtifactTool", () => {
  it("applies a single find/replace edit to the HTML", async () => {
    const result = await updateArtifactTool.execute(
      { id: "linear-triage", edits: [{ find: "OLD", replace: "NEW" }] },
      ctx("conv-A"),
    );
    expect(result.artifactId).toBe("linear-triage");
    expect(writtenHtml()).toContain(">NEW<");
    expect(writtenHtml()).not.toContain(">OLD<");
  });

  it("applies edits sequentially", async () => {
    await updateArtifactTool.execute(
      {
        id: "linear-triage",
        edits: [
          { find: "OLD", replace: "MID" },
          { find: "<body>MID</body>", replace: "<body>FINAL</body>" },
        ],
      },
      ctx("conv-A"),
    );
    expect(writtenHtml()).toContain(">FINAL<");
  });

  it("rejects when a find snippet is not present", async () => {
    await expect(
      updateArtifactTool.execute(
        { id: "linear-triage", edits: [{ find: "NOT_THERE", replace: "x" }] },
        ctx("conv-A"),
      ),
    ).rejects.toThrow(/edit #1: 'find' not found/);
  });

  it("preserves the existing HTML when `edits` is omitted (manifest-only)", async () => {
    await updateArtifactTool.execute(
      { id: "linear-triage", title: "Renamed Triage" },
      ctx("conv-A"),
    );
    expect(writtenHtml()).toContain(">OLD<");
    expect(writtenHtml()).toContain('"title":"Renamed Triage"');
  });

  it("updates the icon when passed", async () => {
    await updateArtifactTool.execute(
      { id: "linear-triage", icon: "📈" },
      ctx("conv-A"),
    );
    expect(writtenHtml()).toContain('"icon":"📈"');
  });

  it("does not accept an html argument (strict schema)", () => {
    const parsed = updateArtifactTool.parameters.safeParse({
      id: "linear-triage",
      html: "<html></html>",
    });
    expect(parsed.success).toBe(false);
  });

  it("does not accept an html_path argument (strict schema)", () => {
    const parsed = updateArtifactTool.parameters.safeParse({
      id: "linear-triage",
      html_path: "x.html",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an edits array in the schema", () => {
    const parsed = updateArtifactTool.parameters.safeParse({
      id: "linear-triage",
      edits: [{ find: "a", replace: "b" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown artifact id", async () => {
    opfs.exists.mockResolvedValue(false);
    await expect(
      updateArtifactTool.execute(
        { id: "does-not-exist", edits: [{ find: "OLD", replace: "x" }] },
        ctx("conv-A"),
      ),
    ).rejects.toThrow(/unknown artifact/i);
  });

  it("requires a conversation id", async () => {
    await expect(
      updateArtifactTool.execute(
        { id: "linear-triage", edits: [{ find: "OLD", replace: "x" }] },
        ctx(null),
      ),
    ).rejects.toThrow(/conversation/i);
  });

  it("does NOT report approvalsReset for a metadata-only change", async () => {
    // title isn't in the security subset canonicalizeManifest hashes, so the
    // manifest version is unchanged -> approvals are not reset, even though the
    // fixture artifact was never installed (installedAt undefined).
    const result = await updateArtifactTool.execute(
      { id: "linear-triage", title: "Renamed Triage" },
      ctx("conv-A"),
    );
    expect(result.approvalsReset).toBe(false);
  });

  it("does NOT report approvalsReset for an HTML-only edit", async () => {
    const result = await updateArtifactTool.execute(
      { id: "linear-triage", edits: [{ find: "OLD", replace: "NEW" }] },
      ctx("conv-A"),
    );
    expect(result.approvalsReset).toBe(false);
  });

  it("reports approvalsReset when the tool surface changes", async () => {
    const result = await updateArtifactTool.execute(
      {
        id: "linear-triage",
        tools: [
          { name: "mcp.linear.list_issues", mode: "read" },
          { name: "mcp.linear.update_issue", mode: "write" },
        ],
      },
      ctx("conv-A"),
    );
    expect(result.approvalsReset).toBe(true);
  });
});
