// Contract test for `linkify.ts` against the markdown parser it targets.
//
// `linkifyMemoryMarkdown` only pays off if the markdown it emits survives the
// renderer, and the two things that could silently break it live in
// react-markdown (which Streamdown wraps), not in our code:
//
//   1. **URL sanitization.** `defaultUrlTransform` drops hrefs whose scheme
//      isn't allow-listed. Our in-app links rely on fragment hrefs (`#wl-`,
//      `#chat-`) being passed through untouched \u2014 that's the whole reason we
//      encode them as fragments rather than a custom scheme.
//   2. **Link destination parsing.** The `[text](<url>)` angle-bracket form is
//      what keeps a `)` inside a cited URL from terminating the link early.
//
// These assert the rendered `href`, so a parser upgrade that changes either
// behavior fails here rather than shipping dead links in the memory viewer.

import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { linkifyMemoryMarkdown } from "../linkify";

function html(md: string): string {
  return renderToStaticMarkup(<Markdown>{linkifyMemoryMarkdown(md)}</Markdown>);
}

describe("linkify output survives the markdown renderer", () => {
  it("turns a scheme-less cited domain into a real external link", () => {
    expect(html("[Source: ycombinator.com/companies/typa]")).toContain(
      '<a href="https://ycombinator.com/companies/typa">ycombinator.com/companies/typa</a>',
    );
  });

  it("preserves parens in a cited URL via the angle-bracket destination", () => {
    expect(html("[Source: en.wikipedia.org/wiki/Foo_(bar)]")).toContain(
      'href="https://en.wikipedia.org/wiki/Foo_(bar)"',
    );
  });

  it("keeps the chat fragment href through URL sanitization", () => {
    expect(html("[Source: [[chat:abc-123]]]")).toContain(
      '<a href="#chat-abc-123">chat</a>',
    );
  });

  it("keeps the note fragment href through URL sanitization", () => {
    expect(html("works with [[garry-tan]]")).toContain(
      '<a href="#wl-garry-tan">garry-tan</a>',
    );
  });

  it("leaves a non-URL source marker as inert text", () => {
    const out = html("[Source: chat]");
    expect(out).not.toContain("<a ");
    expect(out).toContain("[Source: chat]");
  });
});
