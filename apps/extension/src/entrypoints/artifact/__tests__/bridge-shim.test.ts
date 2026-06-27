// apps/extension/src/entrypoints/artifact/__tests__/bridge-shim.test.ts
import { describe, it, expect } from "vitest";
import { BRIDGE_SHIM_SOURCE } from "../bridge-shim";

describe("BRIDGE_SHIM_SOURCE", () => {
  it("is a non-empty string", () => {
    expect(typeof BRIDGE_SHIM_SOURCE).toBe("string");
    expect(BRIDGE_SHIM_SOURCE.length).toBeGreaterThan(100);
  });

  it("parses as valid JavaScript", () => {
    // new Function will throw a SyntaxError if the body isn't valid JS.
    // It runs in a fresh function scope, never executes top-level effects
    // (the IIFE is wrapped, but new Function won't run it).
    expect(() => new Function(BRIDGE_SHIM_SOURCE)).not.toThrow();
  });

  it("does not contain TypeScript-only syntax", () => {
    // Defensive check: catch regressions where someone pastes TS syntax
    // back into the template.
    expect(BRIDGE_SHIM_SOURCE).not.toMatch(/\bas\s+(any|unknown|string|number)\b/);
    expect(BRIDGE_SHIM_SOURCE).not.toMatch(/:\s*(string|number|boolean|any|unknown)\b/);
  });

  it("defines window.openbrowse with the expected surface", () => {
    expect(BRIDGE_SHIM_SOURCE).toContain("window.openbrowse");
    expect(BRIDGE_SHIM_SOURCE).toContain("callMcpTool");
    expect(BRIDGE_SHIM_SOURCE).toContain("runTool");
    expect(BRIDGE_SHIM_SOURCE).toContain("kv");
    expect(BRIDGE_SHIM_SOURCE).toContain("setCardHeight");
    expect(BRIDGE_SHIM_SOURCE).toContain("toast");
    expect(BRIDGE_SHIM_SOURCE).toContain("onThemeChange");
  });

  it("captures runtime errors and a console.error buffer", () => {
    expect(BRIDGE_SHIM_SOURCE).toContain("ART_RUNTIME_ERROR");
    expect(BRIDGE_SHIM_SOURCE).toContain('addEventListener("error"');
    expect(BRIDGE_SHIM_SOURCE).toContain('addEventListener("unhandledrejection"');
    expect(BRIDGE_SHIM_SOURCE).toContain("consoleBuffer");
  });

  it("wires a brokered network.fetch that reconstructs a Response", () => {
    expect(BRIDGE_SHIM_SOURCE).toContain("network:");
    expect(BRIDGE_SHIM_SOURCE).toContain('rpc("network.fetch"');
    expect(BRIDGE_SHIM_SOURCE).toContain("new Response(");
    // Credentials default to omit unless the caller opts in.
    expect(BRIDGE_SHIM_SOURCE).toContain('init.credentials || "omit"');
  });
});
