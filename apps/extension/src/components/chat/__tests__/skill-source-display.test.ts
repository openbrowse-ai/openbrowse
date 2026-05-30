import { describe, expect, it } from "vitest";
import { resolveSkillSourceDisplay } from "../skill-source-display";

describe("resolveSkillSourceDisplay", () => {
  it("owner/repo/subpath shorthand → name from subpath, github link", () => {
    const out = resolveSkillSourceDisplay("sales-skills/sales/sales-attio");
    expect(out.kind).toBe("github");
    expect(out.skillName).toBe("Sales attio");
    expect(out.owner).toBe("sales-skills");
    expect(out.repoUrl).toBe("https://github.com/sales-skills/sales");
    expect(out.avatarUrl).toBe("https://github.com/sales-skills.png");
    expect(out.ownerRepoLabel).toBe("sales-skills/sales/sales-attio");
  });

  it("github: shorthand at repo root → name from repo", () => {
    const out = resolveSkillSourceDisplay("github:anthropics/claude-skills");
    expect(out.kind).toBe("github");
    expect(out.skillName).toBe("Claude skills");
    expect(out.repoUrl).toBe("https://github.com/anthropics/claude-skills");
    expect(out.ownerRepoLabel).toBe("anthropics/claude-skills");
  });

  it("https github url with tree path → name from last subpath segment", () => {
    const out = resolveSkillSourceDisplay(
      "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices",
    );
    expect(out.kind).toBe("github");
    expect(out.skillName).toBe("React best practices");
    expect(out.owner).toBe("vercel-labs");
    expect(out.repoUrl).toBe("https://github.com/vercel-labs/agent-skills");
  });

  it("raw SKILL.md url → name from containing folder + owner avatar", () => {
    const out = resolveSkillSourceDisplay(
      "https://raw.githubusercontent.com/acme/skills/main/cool-skill/SKILL.md",
    );
    expect(out.kind).toBe("raw-skill-md");
    expect(out.skillName).toBe("Cool skill");
    expect(out.owner).toBe("acme");
    expect(out.avatarUrl).toBe("https://github.com/acme.png");
    expect(out.repoUrl).toBe(
      "https://raw.githubusercontent.com/acme/skills/main/cool-skill/SKILL.md",
    );
  });

  it("unrecognized source → invalid, raw shown, no links/avatar", () => {
    const out = resolveSkillSourceDisplay("not a real source");
    expect(out.kind).toBe("invalid");
    expect(out.skillName).toBe("not a real source");
    expect(out.raw).toBe("not a real source");
    expect(out.repoUrl).toBeUndefined();
    expect(out.avatarUrl).toBeUndefined();
  });
});
