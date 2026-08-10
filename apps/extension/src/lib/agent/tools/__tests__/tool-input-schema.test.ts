/**
 * Guard test: every browser tool's `parameters` Zod schema must serialize to
 * a JSON Schema with a top-level `"type": "object"`.
 *
 * Anthropic's Messages API requires `tools[].input_schema.type === "object"`.
 * Schemas that serialize to top-level `{ oneOf: ... }` or `{ anyOf: ... }`
 * (e.g. `z.discriminatedUnion`, `z.union`) — or to non-object roots
 * (e.g. bare `z.string()`, `z.array(...)`) — are rejected with:
 *
 *   tools.<i>.custom.input_schema.type: Field required
 *
 * This regression test enumerates every tool registered into the
 * `browserTools` map in `agent-transport.ts` and asserts the converted
 * schema is a top-level object. Update the list below whenever a new tool
 * is registered.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { clickElementTool } from "../click-element";
import { closeTabsTool } from "../close-tabs";
import { createSkillTool } from "../create-skill";
import { deleteSiteSkillTool } from "../delete-site-skill";
import { executeCodeTool } from "../execute-code";
import { executeOnPageTool } from "../execute-on-page";
import { createPythonTool } from "../execute-python";
import { extractTool } from "../extract";
import { createFsTools } from "../fs";
import { installSkillTool } from "../install-skill";
import { listTabsTool } from "../list-tabs";
import { navigateTool } from "../navigate";
import { patchSiteSkillTool } from "../patch-site-skill";
import { readConsoleMessagesTool } from "../read-console-messages";
import { readNetworkRequestsTool } from "../read-network-requests";
import { readPageTool } from "../read-page";
import { screenshotTool } from "../screenshot";
import { scrollPageTool } from "../scroll-page";
import { searchMemoryTool } from "../search-memory";
import { selectTabTool } from "../select-tab";
import { skillTool } from "../skill";
import { snapshotTool } from "../snapshot";
import { todoWriteTool } from "../todowrite";
import { typeInElementTool } from "../type-in-element";
import { webSearchTool } from "../web-search";

const fsTools = createFsTools();
const pythonTool = createPythonTool();

// Mirrors `browserTools` in agent-transport.ts. Add new tools here when
// they're registered there.
const allTools = [
  ["snapshot", snapshotTool],
  ["readPage", readPageTool],
  ["screenshot", screenshotTool],
  ["listTabs", listTabsTool],
  ["navigate", navigateTool],
  ["clickElement", clickElementTool],
  ["typeInElement", typeInElementTool],
  ["scrollPage", scrollPageTool],
  ["selectTab", selectTabTool],
  ["closeTabs", closeTabsTool],
  ["searchMemory", searchMemoryTool],
  ["executeCode", executeCodeTool],
  ["executeOnPage", executeOnPageTool],
  ["read_network_requests", readNetworkRequestsTool],
  ["read_console_messages", readConsoleMessagesTool],
  ["patch_site_skill", patchSiteSkillTool],
  ["delete_site_skill", deleteSiteSkillTool],
  ["executePython", pythonTool],
  ["extract", extractTool],
  ["webSearch", webSearchTool],
  ["todoWrite", todoWriteTool],
  ["skill", skillTool],
  ["install_skill", installSkillTool],
  ["create_skill", createSkillTool],
  ["Read", fsTools.readTool],
  ["Write", fsTools.writeTool],
  ["Edit", fsTools.editTool],
  ["Glob", fsTools.globTool],
  ["Grep", fsTools.grepTool],
  ["LS", fsTools.lsTool],
  ["Delete", fsTools.deleteTool],
  ["Move", fsTools.moveTool],
] as const;

describe("tool input schemas (Anthropic compatibility)", () => {
  it.each(allTools)(
    "%s parameters serialize to a top-level object schema",
    (_name, tool) => {
      const json = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
      expect(json.type).toBe("object");
      // Sanity: object schemas have a `properties` map (even if empty).
      expect(json).toHaveProperty("properties");
      // Reject top-level union shapes that lack `type`.
      expect(json).not.toHaveProperty("oneOf");
      expect(json).not.toHaveProperty("anyOf");
    },
  );
});
