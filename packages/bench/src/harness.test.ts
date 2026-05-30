/**
 * Tests for the harness module — schema validation, tool-reference checks,
 * and the unified `subagents` field that accepts either built-in slugs or
 * custom `SubagentDef` objects.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineHarness, BUILT_IN_SUBAGENT_SLUGS, type Harness } from "./harness";
import type { BrowserTool } from "@agent/types";

function makeTool(name: string): BrowserTool<unknown, unknown> {
  return {
    name,
    description: `dummy ${name}`,
    parameters: z.object({}),
    execute: async () => ({}),
  } as unknown as BrowserTool<unknown, unknown>;
}

const baseHarness = (over: Partial<Harness> = {}): Harness => ({
  id: "test",
  systemPrompt: "you are a test agent",
  tools: [makeTool("readPage"), makeTool("scrollPage"), makeTool("navigate")],
  ...over,
});

describe("defineHarness — base validation", () => {
  it("accepts a minimal valid harness", () => {
    expect(() => defineHarness(baseHarness())).not.toThrow();
  });

  it("rejects empty tool sets", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        tools: [],
      }),
    ).toThrow();
  });

  it("rejects duplicate tool names", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        tools: [makeTool("readPage"), makeTool("readPage")],
      }),
    ).toThrow(/duplicate tool name/);
  });

  it("errors loudly when pageStateImageTools references a missing tool", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        pageStateImageTools: ["screenshot"], // not in the tools list
      }),
    ).toThrow(/pageStateImageTools.*screenshot/);
  });

  it("errors loudly when terminalToolNames references a missing tool", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        terminalToolNames: ["report"], // not in the tools list
      }),
    ).toThrow(/terminalToolNames.*report/);
  });
});

describe("defineHarness — subagents (unified field)", () => {
  it("accepts a built-in slug as a subagent entry", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        subagents: ["explore"],
      }),
    ).not.toThrow();
  });

  it("accepts both slug AND custom SubagentDef in the same array", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        tools: [makeTool("readPage"), makeTool("scrollPage")],
        subagents: [
          "explore",
          {
            slug: "form-filler",
            description: "fills forms",
            whenToUse: "when you encounter a form",
            systemPrompt: "you are a form filler",
            allowedTools: ["readPage"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an unknown built-in slug", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        // @ts-expect-error -- intentionally invalid
        subagents: ["nope-not-a-built-in"],
      }),
    ).toThrow();
  });

  it("does NOT validate built-in allowedTools against the harness tool set", () => {
    // Built-in "explore" references readPage/snapshot/screenshot/extract/etc;
    // most of those are absent from this minimal harness. defineHarness must
    // still accept the entry — intersection happens at run-time, not here.
    expect(() =>
      defineHarness({
        ...baseHarness(),
        tools: [makeTool("readPage")], // ONLY readPage
        subagents: ["explore"],
      }),
    ).not.toThrow();
  });

  it("strictly validates custom SubagentDef allowedTools (Q25)", () => {
    expect(() =>
      defineHarness({
        ...baseHarness(),
        subagents: [
          {
            slug: "broken",
            description: "x",
            whenToUse: "x",
            systemPrompt: "x",
            allowedTools: ["does-not-exist"],
          },
        ],
      }),
    ).toThrow(/allowedTools.*does-not-exist/);
  });

  it("rejects duplicate slugs across the unified entry list", () => {
    // A user might collide a custom slug with a built-in name.
    expect(() =>
      defineHarness({
        ...baseHarness(),
        subagents: [
          "explore",
          {
            slug: "explore", // collision with the built-in
            description: "x",
            whenToUse: "x",
            systemPrompt: "x",
            allowedTools: ["readPage"],
          },
        ],
      }),
    ).toThrow(/duplicate subagent slug/);
  });

  it("exports the canonical built-in slug list", () => {
    expect([...BUILT_IN_SUBAGENT_SLUGS].sort()).toEqual(["explore", "general"]);
  });
});
