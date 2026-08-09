import { describe, expect, it } from "vitest";
import {
  collapseForTimeline,
  contentHash,
  keywordScore,
  makeSnippet,
  memoryFilePath,
  parseLinks,
  parseMemory,
  parseMemoryPath,
  searchableText,
  serializeMemory,
  slugify,
  tokenize,
  type MemoryDoc,
} from "../format";

describe("slugify", () => {
  it("lowercases, hyphenates, and trims", () => {
    expect(slugify("Garry Tan")).toBe("garry-tan");
    expect(slugify("  PR review workflow!! ")).toBe("pr-review-workflow");
    expect(slugify("github.com")).toBe("github-com");
  });

  it("strips accents", () => {
    expect(slugify("café")).toBe("cafe");
  });

  it("falls back to 'memory' for empty slugs", () => {
    expect(slugify("!!!")).toBe("memory");
    expect(slugify("")).toBe("memory");
  });
});

describe("parseLinks", () => {
  it("extracts and de-dupes wikilink targets as slugs", () => {
    expect(parseLinks("works at [[Acme AI]] with [[garry-tan]]")).toEqual([
      "acme-ai",
      "garry-tan",
    ]);
  });

  it("supports the [[slug|display]] alias form", () => {
    expect(parseLinks("see [[garry-tan|Garry]]")).toEqual(["garry-tan"]);
  });

  it("de-dupes repeated targets", () => {
    expect(parseLinks("[[a]] [[A]] [[a]]")).toEqual(["a"]);
  });

  it("collapses a stray path link to its basename (move-safe)", () => {
    expect(parseLinks("see [[people/garry-tan]]")).toEqual(["garry-tan"]);
    expect(parseLinks("[[work/pat]] and [[friends/pat]]")).toEqual(["pat"]);
  });

  it("returns [] with no links", () => {
    expect(parseLinks("plain text")).toEqual([]);
  });

  it("ignores [[chat:<id>]] provenance links", () => {
    // A chat source marker is not a note reference — counting it would add a
    // permanently dangling node to the memory graph.
    expect(parseLinks("Met up. [Source: [[chat:conv-abc]]]")).toEqual([]);
    expect(
      parseLinks("works with [[garry-tan]] [Source: [[chat:conv-abc]]]"),
    ).toEqual(["garry-tan"]);
  });
});

describe("parseMemoryPath", () => {
  it("parses a global memory path", () => {
    expect(parseMemoryPath("memory/garry-tan.md")).toEqual({
      spaceId: null,
      scope: "user",
      slug: "garry-tan",
      relPath: "garry-tan.md",
    });
  });

  it("parses a nested space memory path, slug from basename", () => {
    expect(parseMemoryPath("spaces/s1/memory/people/garry-tan.md")).toEqual({
      spaceId: "s1",
      scope: "space",
      slug: "garry-tan",
      relPath: "people/garry-tan.md",
    });
  });

  it("tolerates a leading slash", () => {
    expect(parseMemoryPath("/memory/x.md")?.slug).toBe("x");
  });

  it("returns null for non-memory or non-markdown paths", () => {
    expect(parseMemoryPath("conversations/c1/workspace/x.md")).toBeNull();
    expect(parseMemoryPath("memory/notes.txt")).toBeNull();
    expect(parseMemoryPath("spaces/s1/workspace/x.md")).toBeNull();
  });
});

describe("memoryFilePath", () => {
  it("maps global vs space scope to paths", () => {
    expect(memoryFilePath("repo-url", null)).toBe("memory/repo-url.md");
    expect(memoryFilePath("repo-url", "space-1")).toBe(
      "spaces/space-1/memory/repo-url.md",
    );
  });
});

describe("serialize/parse roundtrip", () => {
  const doc: MemoryDoc = {
    title: "PR review workflow",
    description: "How the user likes PRs reviewed",
    type: "reference",
    domain: "github.com",
    aliases: ["pr review", "code review"],
    created: "2026-08-05",
    updated: "2026-08-06",
    truth: "Always open Files Changed first. See [[github-conventions]].",
    timeline: [
      "2026-08-05 — Created. [Source: chat]",
      "2026-08-06 — Prefers squash merges. [Source: chat]",
    ],
  };

  it("round-trips through serialize → parse", () => {
    const text = serializeMemory(doc);
    const parsed = parseMemory(text);
    expect(parsed).toEqual(doc);
  });

  it("round-trips values that need quoting (quotes, commas, colons)", () => {
    // `quoteScalar` quotes these; `stripQuotes` has to unquote *and* unescape
    // them, or a value gains a backslash on every serialize/parse cycle and a
    // comma-bearing alias splits into two entries. Note the leading quote —
    // that's what triggers quoting (an interior quote alone doesn't), so it's
    // the case that actually exercises the `\"` escaping round-trip.
    const tricky: MemoryDoc = {
      ...doc,
      title: '"ship it" is the rule',
      description: "Reviews: fast, thorough",
      aliases: ['Smith, "Jack"', "code review"],
    };
    const parsed = parseMemory(serializeMemory(tricky));
    expect(parsed).toEqual(tricky);
  });

  it("survives repeated serialize/parse cycles without accumulating escapes", () => {
    const tricky: MemoryDoc = { ...doc, title: '"quoted" title' };
    const once = parseMemory(serializeMemory(tricky));
    const twice = parseMemory(serializeMemory(once));
    expect(twice).toEqual(tricky);
  });

  it("emits both headings", () => {
    const text = serializeMemory(doc);
    expect(text).toContain("# Compiled truth");
    expect(text).toContain("# Timeline");
    expect(text).toMatch(/^---\n/);
  });

  it("tolerates a body with no headings (treats all as truth)", () => {
    const parsed = parseMemory(
      "---\ntitle: X\ndescription: d\ntype: user\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\njust a note",
    );
    expect(parsed.truth).toBe("just a note");
    expect(parsed.timeline).toEqual([]);
  });

  it("defaults an unknown type to reference", () => {
    const parsed = parseMemory(
      "---\ntitle: X\ndescription: d\ntype: bogus\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# Compiled truth\nx",
    );
    expect(parsed.type).toBe("reference");
  });
});

describe("searchableText", () => {
  it("joins title, description, aliases, truth, timeline", () => {
    const text = searchableText({
      title: "T",
      description: "D",
      type: "user",
      domain: null,
      aliases: ["A1", "A2"],
      created: "2026-01-01",
      updated: "2026-01-01",
      truth: "TRUTH",
      timeline: ["TL1", "TL2"],
    });
    expect(text).toContain("T");
    expect(text).toContain("D");
    expect(text).toContain("A1");
    expect(text).toContain("TRUTH");
    expect(text).toContain("TL1");
  });
});

describe("tokenize + keywordScore", () => {
  const doc: MemoryDoc = {
    title: "Staging environment",
    description: "Where the staging server lives",
    type: "reference",
    domain: null,
    aliases: ["staging url"],
    created: "2026-01-01",
    updated: "2026-01-01",
    truth: "The staging URL is https://staging.example.com",
    timeline: ["2026-01-01 — noted"],
  };

  it("scores a title hit higher than a body-only hit", () => {
    const titleHit = keywordScore(doc, tokenize("staging"));
    const bodyHit = keywordScore(doc, tokenize("example"));
    expect(titleHit).toBeGreaterThan(bodyHit);
  });

  it("returns 0 for no match", () => {
    expect(keywordScore(doc, tokenize("kubernetes"))).toBe(0);
  });

  it("boosts an exact title/slug match", () => {
    expect(keywordScore(doc, tokenize("staging environment"))).toBeGreaterThan(
      keywordScore(doc, tokenize("staging")),
    );
  });
});

describe("makeSnippet", () => {
  it("prefers a line containing a query term", () => {
    const doc: MemoryDoc = {
      title: "T",
      description: "d",
      type: "user",
      domain: null,
      aliases: [],
      created: "2026-01-01",
      updated: "2026-01-01",
      truth: "line one\nthe secret is 42\nline three",
      timeline: [],
    };
    expect(makeSnippet(doc, tokenize("secret"))).toBe("the secret is 42");
  });
});

describe("collapseForTimeline", () => {
  it("collapses whitespace and truncates", () => {
    expect(collapseForTimeline("a\n\n  b   c")).toBe("a b c");
    const long = "x".repeat(600);
    expect(collapseForTimeline(long).length).toBe(500);
  });
});

describe("contentHash", () => {
  it("is stable and differs on change", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
