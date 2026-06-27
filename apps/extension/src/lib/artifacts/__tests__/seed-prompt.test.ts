import { describe, it, expect } from "vitest";
import { buildErrorFixPrompt } from "../seed-prompt";
import type { ArtifactError } from "../rpc";

describe("buildErrorFixPrompt", () => {
  it("includes the title and message", () => {
    const err: ArtifactError = { source: "toast", message: "Failed to load issues" };
    const out = buildErrorFixPrompt("Linear Triage", err);
    expect(out).toContain('"Linear Triage" artifact is failing');
    expect(out).toContain("> Failed to load issues");
    expect(out).toContain("diagnose the root cause and fix");
  });

  it("omits stack / location / console sections when absent", () => {
    const out = buildErrorFixPrompt("X", { source: "toast", message: "boom" });
    expect(out).not.toContain("Stack:");
    expect(out).not.toContain("Location:");
    expect(out).not.toContain("Recent console output:");
  });

  it("includes stack, location, and recent console when present", () => {
    const err: ArtifactError = {
      source: "runtime",
      message: "TypeError: x is undefined",
      stack: "TypeError: x is undefined\n  at foo (app.js:10:5)",
      sourceFile: "app.js:10:5",
      recentConsole: ["fetch failed", "retrying"],
    };
    const out = buildErrorFixPrompt("My App", err);
    expect(out).toContain("Location: app.js:10:5");
    expect(out).toContain("Stack:");
    expect(out).toContain("at foo (app.js:10:5)");
    expect(out).toContain("Recent console output:");
    expect(out).toContain("fetch failed");
    expect(out).toContain("retrying");
  });

  it("skips the console section when the buffer is empty", () => {
    const out = buildErrorFixPrompt("X", {
      source: "runtime",
      message: "boom",
      recentConsole: [],
    });
    expect(out).not.toContain("Recent console output:");
  });
});
