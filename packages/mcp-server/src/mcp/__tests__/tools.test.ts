import { describe, expect, it } from "vitest";

describe("mcp/tools", () => {
  it("exports all ten tools with schemas", async () => {
    const { ALL_TOOLS } = await import("../tools");
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "cancel_task",
        "get_context",
        "list_spaces",
        "list_windows",
        "open_url",
        "read_page",
        "screenshot",
        "task",
        "task_status",
        "task_wait",
      ].sort(),
    );
    for (const tool of ALL_TOOLS) {
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("each tool has a scope mapping", async () => {
    const { TOOL_SCOPES } = await import("../tools");
    expect(TOOL_SCOPES.get_context).toBe("list_windows");
    expect(TOOL_SCOPES.list_windows).toBe("list_windows");
    expect(TOOL_SCOPES.list_spaces).toBe("list_spaces");
    expect(TOOL_SCOPES.read_page).toBe("read_page");
    expect(TOOL_SCOPES.task).toBe("task");
    expect(TOOL_SCOPES.task_status).toBe("task");
    expect(TOOL_SCOPES.task_wait).toBe("task");
    expect(TOOL_SCOPES.cancel_task).toBe("task");
    expect(TOOL_SCOPES.screenshot).toBe("screenshot");
    expect(TOOL_SCOPES.open_url).toBe("open_url");
  });

  it("task tool requires a prompt parameter", async () => {
    const { ALL_TOOLS } = await import("../tools");
    const task = ALL_TOOLS.find((t) => t.name === "task");
    expect(task?.inputSchema.required).toContain("prompt");
  });

  it("task tool accepts optional space, windowId, confirmation params", async () => {
    const { ALL_TOOLS } = await import("../tools");
    const task = ALL_TOOLS.find((t) => t.name === "task");
    expect(task?.inputSchema.properties).toMatchObject({
      prompt: { type: "string" },
      space: { type: "string" },
      windowId: { type: "number" },
      confirmation: { enum: ["auto", "prompt"] },
    });
  });

  it("cancel_task requires taskId", async () => {
    const { ALL_TOOLS } = await import("../tools");
    const cancel = ALL_TOOLS.find((t) => t.name === "cancel_task");
    expect(cancel?.inputSchema.required).toContain("taskId");
  });

  it("task_status requires taskId", async () => {
    const { ALL_TOOLS } = await import("../tools");
    const ts = ALL_TOOLS.find((t) => t.name === "task_status");
    expect(ts?.inputSchema.required).toContain("taskId");
  });

  it("task_wait requires taskId and accepts optional timeoutMs", async () => {
    const { ALL_TOOLS } = await import("../tools");
    const tw = ALL_TOOLS.find((t) => t.name === "task_wait");
    expect(tw?.inputSchema.required).toContain("taskId");
    expect(tw?.inputSchema.properties).toMatchObject({
      taskId: { type: "string" },
      timeoutMs: { type: "number" },
    });
  });
});
