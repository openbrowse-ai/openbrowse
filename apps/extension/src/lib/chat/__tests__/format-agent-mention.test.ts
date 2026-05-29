import { describe, expect, it } from "vitest";
import {
  formatAgentMentionPrefix,
  parseAgentMentions,
} from "../format-agent-mention";

describe("parseAgentMentions", () => {
  it("returns an empty list when no agent mentions are present", () => {
    expect(parseAgentMentions("hello world")).toEqual([]);
    expect(parseAgentMentions("plain @username here")).toEqual([]);
    expect(parseAgentMentions("email me at foo@bar.com")).toEqual([]);
  });

  it("extracts a single @agent:<slug> mention", () => {
    expect(parseAgentMentions("@agent:extractor summarize this")).toEqual([
      { slug: "extractor" },
    ]);
  });

  it("extracts multiple distinct agent mentions in order", () => {
    expect(
      parseAgentMentions("first @agent:operator then @agent:researcher"),
    ).toEqual([{ slug: "operator" }, { slug: "researcher" }]);
  });

  it("deduplicates repeated mentions of the same slug", () => {
    expect(
      parseAgentMentions("@agent:extractor and again @agent:extractor"),
    ).toEqual([{ slug: "extractor" }]);
  });

  it("accepts hyphens, digits, underscores in slugs", () => {
    expect(parseAgentMentions("use @agent:my-tool_v2 here")).toEqual([
      { slug: "my-tool_v2" },
    ]);
  });

  it("rejects slugs that start with a digit or contain whitespace", () => {
    expect(parseAgentMentions("@agent: leading space")).toEqual([]);
    expect(parseAgentMentions("@agent:")).toEqual([]);
    // Regex enforces `[a-zA-Z]` as the first slug char so digit-led
    // tokens like `@agent:1agent` aren't picked up as mentions.
    expect(parseAgentMentions("@agent:1agent here")).toEqual([]);
  });

  it("requires a word boundary before @ to avoid email collisions", () => {
    expect(parseAgentMentions("foo@agent:extractor bar")).toEqual([]);
  });
});

describe("formatAgentMentionPrefix", () => {
  it("returns empty string when no mentions are present", () => {
    expect(formatAgentMentionPrefix([], new Set(["extractor"]))).toBe("");
  });

  it("returns empty string when none of the mentions match a known agent", () => {
    expect(
      formatAgentMentionPrefix(
        [{ slug: "no-such-agent" }],
        new Set(["extractor"]),
      ),
    ).toBe("");
  });

  it("emits a forced-delegation block for one known agent", () => {
    const out = formatAgentMentionPrefix(
      [{ slug: "extractor" }],
      new Set(["extractor"]),
    );
    expect(out).toContain("explicitly invoked");
    expect(out).toContain("@agent:extractor");
    expect(out).toContain("delegate");
  });

  it("emits a forced-delegation block listing multiple known agents", () => {
    const out = formatAgentMentionPrefix(
      [{ slug: "operator" }, { slug: "researcher" }],
      new Set(["operator", "researcher", "extractor"]),
    );
    expect(out).toContain("@agent:operator");
    expect(out).toContain("@agent:researcher");
  });

  it("filters out unknown slugs and keeps known ones", () => {
    const out = formatAgentMentionPrefix(
      [{ slug: "extractor" }, { slug: "ghost" }],
      new Set(["extractor"]),
    );
    expect(out).toContain("@agent:extractor");
    expect(out).not.toContain("@agent:ghost");
  });
});
