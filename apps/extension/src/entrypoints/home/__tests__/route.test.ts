import { describe, expect, it } from "vitest";
import {
  formatHomeRoute,
  parseHomeRoute,
  sameView,
  type HomeRoute,
} from "../route";

describe("parseHomeRoute", () => {
  it("treats empty hash as chat with no conversation", () => {
    expect(parseHomeRoute("")).toEqual({
      view: "chat",
      conversationId: null,
    });
    expect(parseHomeRoute("#")).toEqual({
      view: "chat",
      conversationId: null,
    });
  });

  it("treats a bare non-reserved token as a conversation id", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parseHomeRoute(`#${id}`)).toEqual({
      view: "chat",
      conversationId: id,
    });
  });

  it("accepts a hash without the leading `#`", () => {
    const id = "abc-123";
    expect(parseHomeRoute(id)).toEqual({
      view: "chat",
      conversationId: id,
    });
  });

  it("parses #scheduled", () => {
    expect(parseHomeRoute("#scheduled")).toEqual({ view: "scheduled" });
  });

  it("parses #spaces (list)", () => {
    expect(parseHomeRoute("#spaces")).toEqual({ view: "spaces" });
  });

  it("collapses legacy #spaces/<id> deep-link to the bare list", () => {
    // The per-space detail view was removed; configuration now lives in
    // the chat LandingPage. Any in-flight pre-removal URL must still
    // resolve to a usable route — the spaces list — instead of
    // crashing or rendering an empty detail page.
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parseHomeRoute(`#spaces/${id}`)).toEqual({ view: "spaces" });
    expect(parseHomeRoute(`#spaces/anything-else`)).toEqual({
      view: "spaces",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseHomeRoute("#  ")).toEqual({
      view: "chat",
      conversationId: null,
    });
  });

  it("never treats reserved tokens as conversation ids", () => {
    // Defensive: even if a `scheduled` literal sneaks in without being
    // matched as the route, it must not be interpreted as a chat id.
    expect(parseHomeRoute("scheduled")).toEqual({ view: "scheduled" });
    expect(parseHomeRoute("spaces")).toEqual({ view: "spaces" });
  });
});

describe("formatHomeRoute", () => {
  it("formats empty chat as '' (no dangling #)", () => {
    expect(formatHomeRoute({ view: "chat", conversationId: null })).toBe("");
  });

  it("formats chat with a conversation id", () => {
    expect(
      formatHomeRoute({ view: "chat", conversationId: "abc-123" }),
    ).toBe("#abc-123");
  });

  it("formats scheduled", () => {
    expect(formatHomeRoute({ view: "scheduled" })).toBe("#scheduled");
  });

  it("formats spaces list", () => {
    expect(formatHomeRoute({ view: "spaces" })).toBe("#spaces");
  });
});

describe("round-trip parse/format", () => {
  const cases: HomeRoute[] = [
    { view: "chat", conversationId: null },
    { view: "chat", conversationId: "abc-123" },
    { view: "chat", conversationId: "11111111-2222-3333-4444-555555555555" },
    { view: "scheduled" },
    { view: "spaces" },
  ];

  for (const route of cases) {
    it(`round-trips ${JSON.stringify(route)}`, () => {
      expect(parseHomeRoute(formatHomeRoute(route))).toEqual(route);
    });
  }
});

describe("sameView", () => {
  it("compares only the view dimension", () => {
    expect(
      sameView(
        { view: "chat", conversationId: null },
        { view: "chat", conversationId: "x" },
      ),
    ).toBe(true);
    expect(
      sameView(
        { view: "chat", conversationId: null },
        { view: "spaces" },
      ),
    ).toBe(false);
    expect(sameView({ view: "scheduled" }, { view: "spaces" })).toBe(false);
  });
});
