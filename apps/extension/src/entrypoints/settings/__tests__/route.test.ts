import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_TAB,
  formatSettingsSearch,
  parseSettingsTab,
  SETTINGS_TAB_IDS,
  type SettingsTabId,
} from "../route";

describe("parseSettingsTab", () => {
  it("returns the default tab when the search string is empty", () => {
    expect(parseSettingsTab("")).toBe(DEFAULT_SETTINGS_TAB);
    expect(parseSettingsTab("?")).toBe(DEFAULT_SETTINGS_TAB);
  });

  it("parses a known tab", () => {
    expect(parseSettingsTab("?tab=models")).toBe("models");
    expect(parseSettingsTab("?tab=skills")).toBe("skills");
  });

  it("accepts the search string with or without a leading `?`", () => {
    expect(parseSettingsTab("tab=memory")).toBe("memory");
    expect(parseSettingsTab("?tab=memory")).toBe("memory");
  });

  it("falls back to the default for an unknown tab name", () => {
    expect(parseSettingsTab("?tab=does-not-exist")).toBe(
      DEFAULT_SETTINGS_TAB,
    );
  });

  it("ignores other params and returns the default when no `tab` is set", () => {
    expect(parseSettingsTab("?utm_source=foo")).toBe(DEFAULT_SETTINGS_TAB);
  });
});

describe("formatSettingsSearch", () => {
  it("encodes the default tab as an empty string", () => {
    expect(formatSettingsSearch(DEFAULT_SETTINGS_TAB)).toBe("");
  });

  it("encodes a non-default tab as `?tab=<id>`", () => {
    expect(formatSettingsSearch("models")).toBe("?tab=models");
  });

  it("removes the `tab` param when switching back to default", () => {
    expect(formatSettingsSearch(DEFAULT_SETTINGS_TAB, "?tab=models")).toBe(
      "",
    );
  });

  it("preserves other query params", () => {
    const out = formatSettingsSearch("skills", "?utm_source=foo");
    // Order isn't guaranteed by URLSearchParams.toString, so parse both
    // sides for a stable assertion.
    const params = new URLSearchParams(out.slice(1));
    expect(params.get("tab")).toBe("skills");
    expect(params.get("utm_source")).toBe("foo");
  });

  it("preserves other params when switching to the default tab", () => {
    const out = formatSettingsSearch(
      DEFAULT_SETTINGS_TAB,
      "?utm_source=foo&tab=models",
    );
    const params = new URLSearchParams(out.slice(1));
    expect(params.has("tab")).toBe(false);
    expect(params.get("utm_source")).toBe("foo");
  });
});

describe("round-trip", () => {
  for (const id of SETTINGS_TAB_IDS) {
    it(`round-trips ${id}`, () => {
      const formatted = formatSettingsSearch(id as SettingsTabId);
      expect(parseSettingsTab(formatted)).toBe(id);
    });
  }
});
