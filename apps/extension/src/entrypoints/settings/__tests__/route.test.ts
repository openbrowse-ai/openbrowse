import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_TAB,
  formatSettingsSearch,
  parseSettingsNote,
  parseSettingsTab,
  SETTINGS_TAB_IDS,
  type SettingsTabId,
} from "../route";

describe("parseSettingsTab", () => {
  it("handles a full URL", () => {
    expect(
      parseSettingsTab("https://example.com/settings.html?tab=models"),
    ).toBe("models");
    expect(
      parseSettingsTab(
        "http://localhost:3000/settings.html?foo=bar&tab=skills",
      ),
    ).toBe("skills");
  });

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

  it("ignores a trailing fragment", () => {
    // The settings page keeps `window.location.hash` when it rewrites the URL,
    // so a full URL handed to the parser can carry one.
    expect(parseSettingsTab("?tab=models#anchor")).toBe("models");
    expect(
      parseSettingsTab("chrome-extension://abc/settings.html?tab=skills#x"),
    ).toBe("skills");
  });

  it("falls back to the default for an unknown tab name", () => {
    expect(parseSettingsTab("?tab=does-not-exist")).toBe(DEFAULT_SETTINGS_TAB);
  });

  it("ignores other params and returns the default when no `tab` is set", () => {
    expect(parseSettingsTab("?utm_source=foo")).toBe(DEFAULT_SETTINGS_TAB);
  });
});

describe("parseSettingsNote", () => {
  it("parses the note path", () => {
    expect(parseSettingsNote("?tab=memory&note=memory/andrew-chung.md")).toBe(
      "memory/andrew-chung.md",
    );
  });

  it("handles a full URL", () => {
    expect(
      parseSettingsNote(
        "chrome-extension://abc/settings.html?tab=memory&note=spaces/s1/memory/notes/a.md",
      ),
    ).toBe("spaces/s1/memory/notes/a.md");
  });

  it("url-decodes the path", () => {
    expect(parseSettingsNote("?note=memory%2Fmy%20note.md")).toBe(
      "memory/my note.md",
    );
  });

  it("strips a trailing fragment from the note path", () => {
    // Without this, `#section` folds into the value and the path never matches
    // a real file, so the viewer would fall back to the graph.
    expect(
      parseSettingsNote("?tab=memory&note=memory/andrew-chung.md#section"),
    ).toBe("memory/andrew-chung.md");
    expect(
      parseSettingsNote(
        "chrome-extension://abc/settings.html?tab=memory&note=memory/a.md#h",
      ),
    ).toBe("memory/a.md");
  });

  it("returns null when absent or empty", () => {
    expect(parseSettingsNote("")).toBeNull();
    expect(parseSettingsNote("?tab=memory")).toBeNull();
    expect(parseSettingsNote("?tab=memory&note=")).toBeNull();
    expect(parseSettingsNote("?tab=memory&note=%20")).toBeNull();
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
    expect(formatSettingsSearch(DEFAULT_SETTINGS_TAB, "?tab=models")).toBe("");
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

  it("encodes the note on the memory tab", () => {
    const out = formatSettingsSearch("memory", "", "memory/andrew-chung.md");
    const params = new URLSearchParams(out.slice(1));
    expect(params.get("tab")).toBe("memory");
    expect(params.get("note")).toBe("memory/andrew-chung.md");
  });

  it("drops the note on any tab other than memory", () => {
    const out = formatSettingsSearch("skills", "", "memory/andrew-chung.md");
    expect(new URLSearchParams(out.slice(1)).has("note")).toBe(false);
  });

  it("clears an existing note when none is passed", () => {
    const out = formatSettingsSearch(
      "memory",
      "?tab=memory&note=memory/andrew-chung.md",
    );
    const params = new URLSearchParams(out.slice(1));
    expect(params.get("tab")).toBe("memory");
    expect(params.has("note")).toBe(false);
  });

  it("clears the note when leaving the memory tab", () => {
    const out = formatSettingsSearch(
      "models",
      "?tab=memory&note=memory/andrew-chung.md",
    );
    const params = new URLSearchParams(out.slice(1));
    expect(params.get("tab")).toBe("models");
    expect(params.has("note")).toBe(false);
  });

  it("preserves other params alongside the note", () => {
    const out = formatSettingsSearch(
      "memory",
      "?utm_source=foo",
      "memory/a.md",
    );
    const params = new URLSearchParams(out.slice(1));
    expect(params.get("utm_source")).toBe("foo");
    expect(params.get("note")).toBe("memory/a.md");
  });

  it("round-trips a note through parseSettingsNote", () => {
    const path = "spaces/s1/memory/notes/my note.md";
    expect(parseSettingsNote(formatSettingsSearch("memory", "", path))).toBe(
      path,
    );
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
