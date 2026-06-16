import { describe, it, expect } from "vitest";
import {
  renderSiteSkillsBlock,
  urlToDomain,
} from "../site-skill-catalog";
import { parseScriptDesc } from "../site-skill-scripts";
import { parseSkillFrontmatter } from "../yaml-frontmatter";
import type { InstalledSkill } from "../types";

function siteSkill(partial: Partial<InstalledSkill> & { name: string }): InstalledSkill {
  return {
    description: "desc",
    source: "site-skill",
    metadata: {},
    kind: "site",
    hasScripts: false,
    scriptTypes: [],
    fileIndex: ["SKILL.md"],
    installedAt: 0,
    ...partial,
  };
}

describe("urlToDomain", () => {
  it("reduces URLs and hosts to the registrable domain", () => {
    expect(urlToDomain("https://www.linkedin.com/feed/")).toBe("linkedin.com");
    expect(urlToDomain("https://github.com")).toBe("github.com");
    expect(urlToDomain("www.example.com")).toBe("example.com");
  });
  it("returns null for junk", () => {
    expect(urlToDomain("")).toBeNull();
    expect(urlToDomain("not a url")).toBeNull();
  });
});

describe("renderSiteSkillsBlock", () => {
  const skills = [
    siteSkill({
      name: "linkedin.com",
      description: "Engagement helpers for LinkedIn.",
      fileIndex: ["SKILL.md", "list-recent-posts.js", "list-comments.js"],
      hasScripts: true,
    }),
    siteSkill({ name: "github.com", description: "GH helpers." }),
  ];

  it("surfaces only site skills whose domain matches an open tab", () => {
    const block = renderSiteSkillsBlock(
      ["https://www.linkedin.com/in/foo/"],
      skills,
    );
    expect(block).toContain("## Site skills for open tabs");
    expect(block).toContain("### linkedin.com");
    expect(block).toContain("Engagement helpers for LinkedIn.");
    // Scripts listed (basenames only).
    expect(block).toContain("list-recent-posts.js");
    expect(block).toContain("list-comments.js");
    // github.com not open → excluded.
    expect(block).not.toContain("### github.com");
    // Drives the reuse/don't-author/self-heal loop.
    expect(block).toContain("REUSE FIRST");
    expect(block).toContain("DON'T AUTHOR");
    expect(block).toContain("SELF-HEAL");
  });

  it("emits a bootstrap line for an open domain with no site skill yet", () => {
    // example.com is open but uncovered → still render the block with a
    // read-only note (authoring is the background curator's job). This is the
    // fix for the empty-block-on-fresh-domain defect.
    const block = renderSiteSkillsBlock(["https://example.com/"], skills);
    expect(block).toContain("## Site skills for open tabs");
    expect(block).toContain("### example.com");
    expect(block).toContain("no site skill yet");
    expect(block).toContain("authored automatically");
    // The foreground is not told to author it.
    expect(block).not.toContain("update_site_skill");
    // No covered skill leaked in.
    expect(block).not.toContain("### linkedin.com");
  });

  it("renders covered and uncovered open domains together", () => {
    const block = renderSiteSkillsBlock(
      ["https://www.linkedin.com/feed/", "https://example.com/"],
      skills,
    );
    expect(block).toContain("### linkedin.com");
    expect(block).toContain("Engagement helpers for LinkedIn.");
    expect(block).toContain("### example.com");
    expect(block).toContain("no site skill yet");
  });

  it("returns empty only when there are no usable open-tab domains", () => {
    expect(renderSiteSkillsBlock([], skills)).toBe("");
    expect(renderSiteSkillsBlock(["not a url"], skills)).toBe("");
  });

  it("treats a disabled site skill as uncovered (bootstrap, not reuse)", () => {
    const disabled = [siteSkill({ name: "linkedin.com", enabled: false })];
    const block = renderSiteSkillsBlock(["https://linkedin.com/"], disabled);
    expect(block).toContain("### linkedin.com");
    expect(block).toContain("no site skill yet");
    // The disabled skill's description must NOT be surfaced as a usable entry.
    expect(block).not.toContain("Scripts (run via executeOnPage scriptRef)");
  });
});

describe("parseScriptDesc", () => {
  it("extracts the @desc header", () => {
    expect(parseScriptDesc("// @desc do X; args: none; returns: y\nreturn 1;")).toBe(
      "do X; args: none; returns: y",
    );
  });
  it("returns null without a header", () => {
    expect(parseScriptDesc("return 1;")).toBeNull();
  });
});

describe("parseSkillFrontmatter — site skill names", () => {
  it("allows dotted domain names when kind: site", () => {
    const { frontmatter } = parseSkillFrontmatter(
      "---\nname: linkedin.com\ndescription: x\nkind: site\n---\nbody",
    );
    expect(frontmatter.name).toBe("linkedin.com");
    expect(frontmatter.kind).toBe("site");
  });

  it("still rejects dotted names for regular skills", () => {
    expect(() =>
      parseSkillFrontmatter("---\nname: bad.name\ndescription: x\n---\nbody"),
    ).toThrow(/lowercase/i);
  });
});
