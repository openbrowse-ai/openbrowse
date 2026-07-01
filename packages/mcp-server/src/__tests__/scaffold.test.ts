import { describe, expect, it } from "vitest";

describe("@openbrowse/mcp-server scaffold", () => {
  it("exports a runServer function", async () => {
    const mod = await import("../index");
    expect(typeof mod.runServer).toBe("function");
  });

  it("has version constant", async () => {
    const mod = await import("../index");
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.VERSION.length).toBeGreaterThan(0);
  });
});
