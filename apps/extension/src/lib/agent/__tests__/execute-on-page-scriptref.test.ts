import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the site-skill script loader so we control what a scriptRef resolves
// to. `parseScriptDesc` is pure, so use the real implementation (the tool
// calls it to attach the `ranScript.desc` descriptor).
const readSiteSkillScript = vi.fn();
vi.mock("@/lib/skills/site-skill-scripts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/skills/site-skill-scripts")>();
  return {
    parseScriptDesc: actual.parseScriptDesc,
    readSiteSkillScript: (...a: unknown[]) => readSiteSkillScript(...a),
  };
});

// Avoid pulling the ref-store's real deps; we only assert it's called.
vi.mock("../ref-store", () => ({ invalidateRefs: vi.fn() }));

import { executeOnPageTool } from "../tools/execute-on-page";
import type { ToolContext } from "../driver";

interface SentCommand {
  method: string;
  params: Record<string, unknown>;
}

function fakeCtx(opts: { sent: SentCommand[]; result?: unknown }): ToolContext {
  return {
    driver: {
      getTab: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: "https://www.linkedin.com/feed/",
        title: "Feed",
      })),
      sendCommand: vi.fn(async (_tabId: unknown, method: string, params: unknown) => {
        opts.sent.push({ method, params: params as Record<string, unknown> });
        if (method === "Runtime.evaluate") {
          return { result: { type: "object", value: opts.result ?? "OK" } } as never;
        }
        return {} as never;
      }),
    },
    session: {
      conversationId: "c1",
      resolveHandle: (h: string) => (h === "t1" ? 7 : undefined),
    },
  } as unknown as ToolContext;
}

beforeEach(() => {
  readSiteSkillScript.mockReset();
});

describe("executeOnPage scriptRef (run saved site-skill script by reference)", () => {
  it("loads a saved script and runs its body in the page", async () => {
    readSiteSkillScript.mockResolvedValue("// @desc x\nreturn document.title;");
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent, result: "Hello" });

    const out = await executeOnPageTool.execute(
      { tab: "t1", scriptRef: { skill: "linkedin.com", script: "extract.js" } },
      ctx,
    );

    expect(readSiteSkillScript).toHaveBeenCalledWith("linkedin.com", "extract.js");
    const evalCall = sent.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall).toBeTruthy();
    // The saved body is embedded in the IIFE; the model's context never held it.
    expect(String(evalCall!.params.expression)).toContain("return document.title;");
    expect(out).toEqual({
      tab: "t1",
      result: "Hello",
      ranScript: { skill: "linkedin.com", script: "extract.js", desc: "x" },
    });
  });

  it("attaches a body-free `ranScript` descriptor (with parsed @desc)", async () => {
    readSiteSkillScript.mockResolvedValue(
      "// @desc list posts on a profile; args: none; returns: array\nreturn [];",
    );
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent, result: [] });

    const out = await executeOnPageTool.execute(
      { tab: "t1", scriptRef: { skill: "linkedin.com", script: "list-posts.js" } },
      ctx,
    );

    expect(out.ranScript).toEqual({
      skill: "linkedin.com",
      script: "list-posts.js",
      desc: "list posts on a profile; args: none; returns: array",
    });
    // The body itself is never surfaced in the result.
    expect(JSON.stringify(out)).not.toContain("return [];");
  });

  it("sets ranScript.desc to null when the saved body has no @desc header", async () => {
    readSiteSkillScript.mockResolvedValue("return 1;");
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent, result: 1 });

    const out = await executeOnPageTool.execute(
      { tab: "t1", scriptRef: { skill: "linkedin.com", script: "bare.js" } },
      ctx,
    );
    expect(out.ranScript).toEqual({
      skill: "linkedin.com",
      script: "bare.js",
      desc: null,
    });
  });

  it("passes args to a saved script", async () => {
    readSiteSkillScript.mockResolvedValue("return args.n + 1;");
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent, result: 6 });

    await executeOnPageTool.execute(
      {
        tab: "t1",
        scriptRef: { skill: "linkedin.com", script: "inc.js" },
        args: JSON.stringify({ n: 5 }),
      },
      ctx,
    );
    const evalCall = sent.find((c) => c.method === "Runtime.evaluate")!;
    expect(String(evalCall.params.expression)).toContain('const args = {"n":5}');
  });

  it("errors clearly when the saved script does not exist", async () => {
    readSiteSkillScript.mockResolvedValue(null);
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent });

    const out = await executeOnPageTool.execute(
      { tab: "t1", scriptRef: { skill: "linkedin.com", script: "missing.js" } },
      ctx,
    );
    expect(out.error).toMatch(/No script/);
    // Never attempted to evaluate anything in the page.
    expect(sent.some((c) => c.method === "Runtime.evaluate")).toBe(false);
  });

  it("rejects when both code and scriptRef are provided", async () => {
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent });
    const out = await executeOnPageTool.execute(
      {
        tab: "t1",
        code: "return 1;",
        scriptRef: { skill: "linkedin.com", script: "x.js" },
      },
      ctx,
    );
    expect(out.error).toMatch(/EITHER/i);
    expect(readSiteSkillScript).not.toHaveBeenCalled();
  });

  it("errors when neither code nor scriptRef is provided", async () => {
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent });
    const out = await executeOnPageTool.execute({ tab: "t1" } as never, ctx);
    expect(out.error).toMatch(/either/i);
  });

  it("still runs inline code (back-compat)", async () => {
    const sent: SentCommand[] = [];
    const ctx = fakeCtx({ sent, result: 2 });
    const out = await executeOnPageTool.execute(
      { tab: "t1", kind: "write", code: "return 1 + 1;" },
      ctx,
    );
    expect(out).toEqual({ tab: "t1", result: 2 });
    expect(readSiteSkillScript).not.toHaveBeenCalled();
  });
});
