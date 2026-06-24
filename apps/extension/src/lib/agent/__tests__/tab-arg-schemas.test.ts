import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  clickElementTool,
  executeOnPageTool,
  extractTool,
  listTabsTool,
  navigateTool,
  readConsoleMessagesTool,
  readNetworkRequestsTool,
  readPageTool,
  scrollPageTool,
  screenshotTool,
  snapshotTool,
  typeInElementTool,
  selectTabTool,
} from "../tools";

/**
 * Schema-level tests for the explicit-`tab`-arg refactor. We don't exercise
 * the tools' execute() paths here (those need a live BrowserDriver); we
 * just verify the parameter contracts so the agent's tool calls are
 * statically validated against the new requirement.
 */
describe("tab-arg schemas", () => {
  describe("required `tab` arg on tab-interacting tools", () => {
    const cases: Array<{ name: string; tool: { parameters: unknown }; extra?: Record<string, unknown> }> = [
      { name: "snapshot", tool: snapshotTool },
      { name: "readPage", tool: readPageTool },
      { name: "read_network_requests", tool: readNetworkRequestsTool },
      { name: "read_console_messages", tool: readConsoleMessagesTool },
      { name: "screenshot", tool: screenshotTool },
      { name: "scrollPage", tool: scrollPageTool, extra: { direction: "down" } },
      {
        name: "clickElement",
        tool: clickElementTool,
        extra: { target: "@e1" },
      },
      {
        name: "typeInElement",
        tool: typeInElementTool,
        extra: { target: "@e1", text: "hi" },
      },
      {
        name: "executeOnPage",
        tool: executeOnPageTool,
        // `code` requires `kind` — the schema's refinement enforces
        // the documented contract that the agent declares read/write
        // intent for inline scripts.
        extra: { code: "return 1", kind: "read" },
      },
      {
        name: "extract",
        tool: extractTool,
        extra: { instruction: "x" },
      },
      { name: "selectTab", tool: selectTabTool },
    ];

    for (const { name, tool, extra } of cases) {
      it(`${name} rejects input without \`tab\``, () => {
        const schema = tool.parameters as { safeParse: (i: unknown) => { success: boolean } };
        const result = schema.safeParse({ ...(extra ?? {}) });
        expect(result.success).toBe(false);
      });

      it(`${name} accepts input with \`tab\``, () => {
        const schema = tool.parameters as { safeParse: (i: unknown) => { success: boolean } };
        const result = schema.safeParse({ tab: "t1", ...(extra ?? {}) });
        expect(result.success).toBe(true);
      });
    }
  });

  describe("navigate accepts both with-tab and without-tab", () => {
    it("accepts { url } alone (bootstrap path: create new tab)", () => {
      const schema = navigateTool.parameters as {
        safeParse: (i: unknown) => { success: boolean };
      };
      const result = schema.safeParse({ url: "https://example.com" });
      expect(result.success).toBe(true);
    });

    it("accepts { url, tab } (navigate existing tab)", () => {
      const schema = navigateTool.parameters as {
        safeParse: (i: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        url: "https://example.com",
        tab: "t1",
      });
      expect(result.success).toBe(true);
    });

    it("rejects unknown extra fields (`newTab` is gone)", () => {
      const schema = navigateTool.parameters as {
        safeParse: (i: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        url: "https://example.com",
        newTab: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("listTabs takes no args (still)", () => {
    // listTabs is the discovery tool; it's the one tab-interacting tool that
    // shouldn't require a `tab` arg because the whole point is to enumerate.
    // Sanity assertion: if a future change adds `tab` to it, this test fails
    // to force re-thinking the design.
    it("listTabs accepts an empty input", () => {
      const schema = listTabsTool.parameters as {
        safeParse: (i: unknown) => { success: boolean };
      };
      expect(schema.safeParse({}).success).toBe(true);
    });
  });
});
