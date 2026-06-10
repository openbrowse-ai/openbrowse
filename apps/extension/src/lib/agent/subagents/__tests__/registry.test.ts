import { describe, expect, it } from "vitest";
import { exploreAgent } from "../built-ins/explore";
import { generalAgent } from "../built-ins/general";
import { getAgent, listAgents } from "../registry";

describe("subagent registry", () => {
  it("listAgents includes the explore and general built-ins", () => {
    const agents = listAgents();
    expect(agents.find((a) => a.slug === "explore")).toEqual(exploreAgent);
    expect(agents.find((a) => a.slug === "general")).toEqual(generalAgent);
  });

  it("getAgent returns the matching built-in by slug", () => {
    expect(getAgent("explore")).toEqual(exploreAgent);
    expect(getAgent("general")).toEqual(generalAgent);
  });

  it("getAgent returns undefined for unknown slugs", () => {
    expect(getAgent("does-not-exist")).toBeUndefined();
  });

  it("every built-in agent has a unique slug", () => {
    const agents = listAgents();
    const slugs = agents.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every built-in agent declares source: 'built-in'", () => {
    for (const agent of listAgents()) {
      expect(agent.source).toBe("built-in");
    }
  });
});

describe("cua built-in", () => {
  it("is registered with custom CUA tool source and attached isolation", () => {
    const cua = getAgent("cua");
    expect(cua).toBeDefined();
    expect(cua?.toolSource).toBe("custom");
    expect(cua?.custom?.kind).toBe("cua");
    expect(cua?.defaultIsolation).toBe("attached");
  });
});
