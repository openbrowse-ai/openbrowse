import { describe, expect, it } from "vitest";
import {
  buildModelHaystack,
  matchesModelQuery,
} from "../ModelPicker";

describe("buildModelHaystack", () => {
  it("combines name, compound id, and provider label, lowercased", () => {
    expect(
      buildModelHaystack("Gemini 3.5 Flash", "google:gemini-3.5-flash", "Google"),
    ).toBe("gemini 3.5 flash google:gemini-3.5-flash google");
  });
});

describe("matchesModelQuery", () => {
  const haystack = buildModelHaystack(
    "Gemini 3.5 Flash",
    "google:gemini-3.5-flash",
    "Google",
  );

  it("matches reordered terms (the reported bug)", () => {
    expect(matchesModelQuery(haystack, "flash 3.5")).toBe(true);
    expect(matchesModelQuery(haystack, "3.5 flash")).toBe(true);
  });

  it("matches in-order and single terms", () => {
    expect(matchesModelQuery(haystack, "gemini 3.5 flash")).toBe(true);
    expect(matchesModelQuery(haystack, "flash")).toBe(true);
    expect(matchesModelQuery(haystack, "gemini")).toBe(true);
  });

  it("matches partial tokens", () => {
    expect(matchesModelQuery(haystack, "gem fl")).toBe(true);
  });

  it("matches against provider label and raw model id", () => {
    expect(matchesModelQuery(haystack, "google flash")).toBe(true);
    expect(matchesModelQuery(haystack, "gemini-3.5")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesModelQuery(haystack, "FLASH Gemini")).toBe(true);
  });

  it("collapses extra whitespace between terms", () => {
    expect(matchesModelQuery(haystack, "  flash    3.5 ")).toBe(true);
  });

  it("empty / whitespace-only query matches everything", () => {
    expect(matchesModelQuery(haystack, "")).toBe(true);
    expect(matchesModelQuery(haystack, "   ")).toBe(true);
  });

  it("returns false when any term is absent", () => {
    expect(matchesModelQuery(haystack, "flash opus")).toBe(false);
    expect(matchesModelQuery(haystack, "claude")).toBe(false);
  });
});
