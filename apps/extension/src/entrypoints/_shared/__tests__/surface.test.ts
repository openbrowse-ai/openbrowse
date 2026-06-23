import { describe, expect, it } from "vitest";
import {
  shouldHostScheduledRuns,
  resolveInitialSpaceId,
  formatDocumentTitle,
  type Surface,
} from "../surface";

describe("shouldHostScheduledRuns", () => {
  it("returns true on home", () => {
    expect(shouldHostScheduledRuns("home")).toBe(true);
  });
  it("returns false on newtab", () => {
    expect(shouldHostScheduledRuns("newtab")).toBe(false);
  });
});

describe("resolveInitialSpaceId", () => {
  const spaces = [
    { id: "sp-a", windowId: 10 },
    { id: "sp-b", windowId: 20 },
    { id: "sp-c", windowId: null },
  ];

  it("home: prefers ?space=<id> when it matches a known space", () => {
    expect(
      resolveInitialSpaceId({
        surface: "home",
        urlSearch: "?space=sp-b",
        currentWindowId: 10,
        spaces,
      }),
    ).toBe("sp-b");
  });

  it("home: ignores ?space=<id> when it does not match any known space, falls through to windowId", () => {
    expect(
      resolveInitialSpaceId({
        surface: "home",
        urlSearch: "?space=sp-zzz",
        currentWindowId: 10,
        spaces,
      }),
    ).toBe("sp-a");
  });

  it("newtab: ignores ?space=<id> entirely, uses windowId", () => {
    expect(
      resolveInitialSpaceId({
        surface: "newtab",
        urlSearch: "?space=sp-b",
        currentWindowId: 10,
        spaces,
      }),
    ).toBe("sp-a");
  });

  it("falls back to windowId match when no space param", () => {
    expect(
      resolveInitialSpaceId({
        surface: "home",
        urlSearch: "",
        currentWindowId: 20,
        spaces,
      }),
    ).toBe("sp-b");
  });

  it("returns null when nothing matches (space-less is first-class)", () => {
    expect(
      resolveInitialSpaceId({
        surface: "newtab",
        urlSearch: "",
        currentWindowId: 999,
        spaces,
      }),
    ).toBe(null);
  });

  it("returns null when there are no spaces", () => {
    expect(
      resolveInitialSpaceId({
        surface: "newtab",
        urlSearch: "",
        currentWindowId: 1,
        spaces: [],
      }),
    ).toBe(null);
  });

  it("returns null when current window has no id and no space param matched", () => {
    expect(
      resolveInitialSpaceId({
        surface: "home",
        urlSearch: "",
        currentWindowId: undefined,
        spaces,
      }),
    ).toBe(null);
  });

  it("treats null windowId on a space as not matching the current window", () => {
    // Production Space type uses `windowId: number | null`. A null
    // windowId (space not currently bound to a window) must never match
    // a real chrome window id.
    expect(
      resolveInitialSpaceId({
        surface: "newtab",
        urlSearch: "",
        currentWindowId: 30,
        spaces: [{ id: "sp-detached", windowId: null }],
      }),
    ).toBe(null);
  });
});

describe("formatDocumentTitle", () => {
  it("home with active space: '<name> — OpenBrowse'", () => {
    expect(formatDocumentTitle("home", "Personal")).toBe("Personal — OpenBrowse");
  });
  it("newtab with active space and no chat: '<name> — OpenBrowse'", () => {
    expect(formatDocumentTitle("newtab", "Personal")).toBe("Personal — OpenBrowse");
  });
  it("home with no active space: 'OpenBrowse'", () => {
    expect(formatDocumentTitle("home", null)).toBe("OpenBrowse");
  });
  it("newtab with no active space: 'OpenBrowse' (no space name yet)", () => {
    expect(formatDocumentTitle("newtab", null)).toBe("OpenBrowse");
  });

  it("newtab with active chat: chat title takes precedence over space", () => {
    expect(
      formatDocumentTitle("newtab", "Personal", "Refactor the agent loop"),
    ).toBe("Refactor the agent loop — OpenBrowse");
  });
  it("newtab with active chat and no space: chat title still wins", () => {
    expect(
      formatDocumentTitle("newtab", null, "Refactor the agent loop"),
    ).toBe("Refactor the agent loop — OpenBrowse");
  });
  it("newtab with empty chat title: falls back to space", () => {
    expect(formatDocumentTitle("newtab", "Personal", "")).toBe(
      "Personal — OpenBrowse",
    );
  });
  it("home ignores chat title (space-only behavior preserved)", () => {
    expect(
      formatDocumentTitle("home", "Personal", "Refactor the agent loop"),
    ).toBe("Personal — OpenBrowse");
  });
});

// Type-only check — fails compile if Surface drifts.
const _surfaces: Surface[] = ["home", "newtab"];
void _surfaces;
