import { describe, expect, it } from "vitest";
import { readConsoleMessagesTool } from "../read-console-messages";

describe("read_console_messages schema", () => {
  it("requires `tab`", () => {
    expect(readConsoleMessagesTool.parameters.safeParse({}).success).toBe(false);
  });
  it("accepts `tab` plus optional filters", () => {
    const r = readConsoleMessagesTool.parameters.safeParse({
      tab: "t1", pattern: "error|warn", onlyErrors: true, limit: 50, clear: true,
    });
    expect(r.success).toBe(true);
  });
  it("does not require approval", () => {
    expect(readConsoleMessagesTool.approval?.required ?? false).toBe(false);
  });
});
