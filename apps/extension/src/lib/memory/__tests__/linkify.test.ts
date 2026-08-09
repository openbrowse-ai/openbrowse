import { describe, expect, it } from "vitest";
import {
  CHATLINK_HREF_PREFIX,
  isBareDomain,
  linkifyMemoryMarkdown,
  WIKILINK_HREF_PREFIX,
} from "../linkify";

describe("isBareDomain", () => {
  it("accepts domain-shaped tokens", () => {
    expect(isBareDomain("typa.ai")).toBe(true);
    expect(isBareDomain("ycombinator.com/companies/typa")).toBe(true);
    expect(isBareDomain("www.example.co.uk")).toBe(true);
    expect(isBareDomain("example.com:8080/a?b=c")).toBe(true);
  });

  it("rejects tokens with no dot", () => {
    expect(isBareDomain("chat")).toBe(false);
    expect(isBareDomain("migration")).toBe(false);
  });

  it("rejects filenames whose extension happens to be a TLD", () => {
    // `.ts` (Tuvalu) and `.sh` (St. Helena) are real TLDs, but in a citation
    // these are overwhelmingly file references.
    expect(isBareDomain("format.ts")).toBe(false);
    expect(isBareDomain("notes.md")).toBe(false);
    expect(isBareDomain("setup.sh")).toBe(false);
    expect(isBareDomain("data.json")).toBe(false);
  });
});

describe("linkifyMemoryMarkdown \u2014 note links", () => {
  it("rewrites a bare wikilink to a fragment link", () => {
    expect(linkifyMemoryMarkdown("works with [[garry-tan]]")).toBe(
      `works with [garry-tan](${WIKILINK_HREF_PREFIX}garry-tan)`,
    );
  });

  it("supports the [[target|display]] alias form", () => {
    expect(linkifyMemoryMarkdown("[[garry-tan|Garry]]")).toBe(
      `[Garry](${WIKILINK_HREF_PREFIX}garry-tan)`,
    );
  });

  it("collapses a stray path to its basename", () => {
    expect(linkifyMemoryMarkdown("[[people/garry-tan]]")).toBe(
      `[garry-tan](${WIKILINK_HREF_PREFIX}garry-tan)`,
    );
  });

  it("leaves an empty target alone", () => {
    expect(linkifyMemoryMarkdown("[[ ]]")).toBe("[[ ]]");
  });
});

describe("linkifyMemoryMarkdown \u2014 chat source links", () => {
  const id = "0f8c1a92-4b7d-4c1e-9f3a-2b6d8e5c7a11";

  it("rewrites [[chat:<id>]] to a chat fragment link labelled 'chat'", () => {
    // The default label keeps the long-standing "[Source: chat]" look; the only
    // change the user sees is that it's now clickable.
    expect(
      linkifyMemoryMarkdown(`Met at the dinner. [Source: [[chat:${id}]]]`),
    ).toBe(`Met at the dinner. [Source: [chat](${CHATLINK_HREF_PREFIX}${id})]`);
  });

  it("honours an explicit display label", () => {
    expect(linkifyMemoryMarkdown(`[[chat:${id}|YC research]]`)).toBe(
      `[YC research](${CHATLINK_HREF_PREFIX}${id})`,
    );
  });

  it("percent-encodes the id", () => {
    expect(linkifyMemoryMarkdown("[[chat:a b]]")).toBe(
      `[chat](${CHATLINK_HREF_PREFIX}a%20b)`,
    );
  });

  it("leaves a scheme with no id alone", () => {
    expect(linkifyMemoryMarkdown("[[chat:]]")).toBe("[[chat:]]");
  });

  it("does not treat a chat link as a note link", () => {
    expect(linkifyMemoryMarkdown(`[[chat:${id}]]`)).not.toContain(
      WIKILINK_HREF_PREFIX,
    );
  });
});

describe("linkifyMemoryMarkdown \u2014 web source citations", () => {
  it("linkifies a scheme-less domain (the case GFM autolinking misses)", () => {
    expect(
      linkifyMemoryMarkdown("[Source: ycombinator.com/companies/typa]"),
    ).toBe(
      "[Source: [ycombinator.com/companies/typa](<https://ycombinator.com/companies/typa>)]",
    );
  });

  it("normalizes a scheme-ful URL into an explicit link", () => {
    // Left to GFM autolinking, the closing `]` of the citation can be absorbed
    // into the href.
    expect(linkifyMemoryMarkdown("[Source: https://typa.ai/about]")).toBe(
      "[Source: [typa.ai/about](<https://typa.ai/about>)]",
    );
  });

  it("strips a trailing slash from the display text only", () => {
    expect(linkifyMemoryMarkdown("[Source: https://typa.ai/]")).toBe(
      "[Source: [typa.ai](<https://typa.ai/>)]",
    );
  });

  it("leaves non-URL source markers untouched", () => {
    expect(linkifyMemoryMarkdown("[Source: chat]")).toBe("[Source: chat]");
    expect(linkifyMemoryMarkdown("[Source: migration]")).toBe(
      "[Source: migration]",
    );
  });

  it("leaves an already-linked source untouched", () => {
    const already = "[Source: [typa](https://typa.ai)]";
    expect(linkifyMemoryMarkdown(already)).toBe(already);
  });

  it("preserves parens in the URL via an angle-bracket destination", () => {
    expect(
      linkifyMemoryMarkdown("[Source: en.wikipedia.org/wiki/Foo_(bar)]"),
    ).toContain("(<https://en.wikipedia.org/wiki/Foo_(bar)>)");
  });
});

describe("linkifyMemoryMarkdown \u2014 combined", () => {
  it("handles note links, a chat source, and a web source in one document", () => {
    const id = "conv-1";
    const md = [
      "Typa is led by [[andrew-chung]].",
      "",
      "- 2026-08-06 \u2014 Founded 2023. [Source: ycombinator.com/companies/typa]",
      `- 2026-08-06 \u2014 Tagline confirmed. [Source: [[chat:${id}]]]`,
    ].join("\n");

    const out = linkifyMemoryMarkdown(md);
    expect(out).toContain(
      `[andrew-chung](${WIKILINK_HREF_PREFIX}andrew-chung)`,
    );
    expect(out).toContain(
      "[ycombinator.com/companies/typa](<https://ycombinator.com/companies/typa>)",
    );
    expect(out).toContain(`[chat](${CHATLINK_HREF_PREFIX}conv-1)`);
    // No raw wikilink syntax should survive.
    expect(out).not.toContain("[[");
  });
});
