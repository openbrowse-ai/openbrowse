import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The fs tools (Read/Write/Edit/Glob/Grep/LS) must resolve the conversation
 * id from the per-call `ToolContext` (`ctx.session.conversationId`), not from
 * a build-time closure. Otherwise:
 *
 *   - A brand-new chat (transport built before the conversation row existed)
 *     writes to the wrong `cwd` root instead of the conversation workspace.
 *   - A subagent (which reuses the parent's tool instances but is handed the
 *     child's ToolContext) writes to the PARENT workspace instead of its own.
 *
 * Workspace paths are `conversations/{cid}/workspace/{relative}`.
 */

const opfs = vi.hoisted(() => ({
  writeFile: vi.fn(async (_path: string, _content: string) => undefined),
  readFile: vi.fn(async (_path: string) => "hello\nworld"),
  exists: vi.fn(async (_path: string) => true),
  readDir: vi.fn(async (_path: string) => ["a.txt", "b.txt"]),
}));

vi.mock("@/lib/vfs/opfs", () => ({ OPFS: opfs }));

import { createFsTools } from "../fs";
import type { ToolContext } from "../../driver/tool-context";

function ctxWith(conversationId: string | null): ToolContext {
  return {
    driver: {} as ToolContext["driver"],
    session: { conversationId, spaceId: null },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("fs tools — conversation id resolution", () => {
  it("Write targets the call-time ctx conversation workspace", async () => {
    const { writeTool } = createFsTools();
    await writeTool.execute(
      { file_path: "out.csv", content: "x" },
      ctxWith("conv-A"),
    );

    expect(opfs.writeFile).toHaveBeenCalledTimes(1);
    expect(opfs.writeFile.mock.calls[0][0]).toBe(
      "conversations/conv-A/workspace/out.csv",
    );
  });

  it("Write targets the CHILD workspace when run as a subagent", async () => {
    const { writeTool } = createFsTools();
    await writeTool.execute(
      { file_path: "out.csv", content: "x" },
      ctxWith("child-conv"),
    );

    expect(opfs.writeFile.mock.calls[0][0]).toBe(
      "conversations/child-conv/workspace/out.csv",
    );
  });

  it("Read resolves under the ctx conversation workspace", async () => {
    const { readTool } = createFsTools();
    await readTool.execute({ file_path: "notes.txt" }, ctxWith("conv-A"));

    expect(opfs.exists.mock.calls[0][0]).toBe(
      "conversations/conv-A/workspace/notes.txt",
    );
  });

  it("LS resolves under the ctx conversation workspace", async () => {
    const { lsTool } = createFsTools();
    await lsTool.execute({ path: "." }, ctxWith("conv-A"));

    // root listing → `conversations/conv-A/workspace/` (trailing slash is
    // resolveVfsPath's existing behavior for an empty relative path)
    expect(opfs.exists.mock.calls[0][0]).toBe(
      "conversations/conv-A/workspace/",
    );
  });
});
