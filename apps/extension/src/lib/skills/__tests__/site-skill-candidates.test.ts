import { describe, it, expect } from "vitest";
import {
  extractSiteSkillCandidates,
  detectNotableActivityDomain,
} from "../site-skill-candidates";

// Minimal message shape mirroring ai-SDK UIMessage parts.
function msg(role: string, parts: unknown[]) {
  return { role, parts } as never;
}
function execPart(input: unknown, output: unknown, state = "output-available") {
  return { type: "tool-executeOnPage", state, input, output };
}

describe("extractSiteSkillCandidates", () => {
  const longCode =
    "const posts = [...document.querySelectorAll('.x')].map(e => e.innerText);\nreturn posts;";

  it("captures a non-trivial inline executeOnPage on a catalog domain", () => {
    const messages = [
      msg("user", [{ type: "text", text: "find YC posts" }]),
      msg("assistant", [execPart({ tab: "t1", code: longCode }, [{ a: 1 }])]),
    ];
    const out = extractSiteSkillCandidates({
      messages,
      catalogDomains: ["linkedin.com"],
      activeUrl: "https://www.linkedin.com/feed/",
    });
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("linkedin.com");
    expect(out[0].code).toBe(longCode);
    expect(out[0].observedResult).toContain("a");
  });

  it("ignores scriptRef runs (already saved) and trivial probes", () => {
    const messages = [
      msg("assistant", [
        execPart(
          { tab: "t1", scriptRef: { skill: "linkedin.com", script: "a.js" } },
          [1],
        ),
        execPart({ tab: "t1", code: "return 1;" }, [1]), // trivial
      ]),
    ];
    const out = extractSiteSkillCandidates({
      messages,
      catalogDomains: ["linkedin.com"],
      activeUrl: "https://www.linkedin.com/feed/",
    });
    expect(out).toHaveLength(0);
  });

  it("ignores executeOnPage with empty/error results", () => {
    const messages = [
      msg("assistant", [
        execPart({ tab: "t1", code: longCode }, []),
        execPart({ tab: "t1", code: longCode }, null, "output-error"),
      ]),
    ];
    const out = extractSiteSkillCandidates({
      messages,
      catalogDomains: ["linkedin.com"],
      activeUrl: "https://www.linkedin.com/feed/",
    });
    expect(out).toHaveLength(0);
  });

  it("returns empty when the active domain isn't in the catalog", () => {
    const messages = [
      msg("assistant", [execPart({ tab: "t1", code: longCode }, [{ a: 1 }])]),
    ];
    const out = extractSiteSkillCandidates({
      messages,
      catalogDomains: ["github.com"],
      activeUrl: "https://www.linkedin.com/feed/",
    });
    expect(out).toHaveLength(0);
  });

  it("returns empty when there is no active url", () => {
    const messages = [
      msg("assistant", [execPart({ tab: "t1", code: longCode }, [{ a: 1 }])]),
    ];
    const out = extractSiteSkillCandidates({
      messages,
      catalogDomains: ["linkedin.com"],
      activeUrl: undefined,
    });
    expect(out).toHaveLength(0);
  });
});

describe("detectNotableActivityDomain", () => {
  const linkedinCatalog = {
    catalogDomains: ["linkedin.com"],
    activeUrl: "https://www.linkedin.com/in/x/recent-activity/all/",
  };

  it("flags the active domain when a tool call errored (output-error state)", () => {
    const messages = [
      msg("assistant", [
        { type: "tool-navigate", state: "output-error", input: {}, output: null },
      ]),
    ];
    expect(
      detectNotableActivityDomain({ messages, ...linkedinCatalog }),
    ).toBe("linkedin.com");
  });

  it("flags the active domain when a tool output carries an error field", () => {
    const messages = [
      msg("assistant", [
        {
          type: "tool-navigate",
          state: "output-available",
          input: { url: "..." },
          output: { error: "Tab load timed out" },
        },
      ]),
    ];
    expect(
      detectNotableActivityDomain({ messages, ...linkedinCatalog }),
    ).toBe("linkedin.com");
  });

  it("returns null when no tool call failed", () => {
    const messages = [
      msg("assistant", [
        {
          type: "tool-snapshot",
          state: "output-available",
          input: {},
          output: { snapshot: "ok" },
        },
      ]),
    ];
    expect(
      detectNotableActivityDomain({ messages, ...linkedinCatalog }),
    ).toBeNull();
  });

  it("returns null when the active domain isn't in the catalog", () => {
    const messages = [
      msg("assistant", [
        { type: "tool-navigate", state: "output-error", input: {}, output: null },
      ]),
    ];
    expect(
      detectNotableActivityDomain({
        messages,
        catalogDomains: ["github.com"],
        activeUrl: "https://www.linkedin.com/feed/",
      }),
    ).toBeNull();
  });
});
