import { describe, it, expect } from "vitest";
import { addedByForSkill, parseSkillSource } from "./source";

describe("addedByForSkill", () => {
  it("returns OpenBrowse for site skills", () => {
    expect(addedByForSkill("site-skill", undefined)).toBe("OpenBrowse");
    // metadata.author must not override the site-skill default.
    expect(addedByForSkill("site-skill", { author: "ignored" })).toBe(
      "OpenBrowse",
    );
  });

  it("returns OpenBrowse (or YAML author) for bundled skills", () => {
    expect(addedByForSkill("bundled", undefined)).toBe("OpenBrowse");
    expect(addedByForSkill("bundled", { author: "Anthropic" })).toBe(
      "Anthropic",
    );
  });

  it("prefers explicit YAML author for installed skills", () => {
    expect(
      addedByForSkill("github:owner/repo", { author: "Jane Dev" }),
    ).toBe("Jane Dev");
  });

  it("humanizes the org for github sources without an author", () => {
    expect(addedByForSkill("github:anthropics/claude-skills", undefined)).toBe(
      "Anthropics",
    );
  });

  it("falls back to the raw source for unknown formats", () => {
    expect(addedByForSkill("local-draft", undefined)).toBe("local-draft");
  });
});

describe("parseSkillSource", () => {
  it("parses github: protocol", () => {
    expect(parseSkillSource("github:owner/repo/sub/path")).toEqual({
      org: "owner",
      displayName: "owner/repo",
      repoUrl: "https://github.com/owner/repo",
    });
  });

  it("returns null for site-skill / bundled / empty", () => {
    expect(parseSkillSource("site-skill")).toBeNull();
    expect(parseSkillSource("bundled")).toBeNull();
    expect(parseSkillSource("")).toBeNull();
  });
});
