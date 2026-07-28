import { describe, expect, it } from "vitest";
import type { ActionItem } from "../components/actions";
import type { Match } from "./matches";
import {
    buildArtifactMatches,
    buildChatMatches,
    buildSpaceMatches,
    commandToPaletteResult,
    flattenGroups,
    groupResults,
    matchToPaletteResult,
    parseScope,
    type ArtifactLite,
    type ChatLite,
    type GroupInput,
    type PaletteResult,
    type SpaceLite,
} from "./palette";

function chat(over: Partial<ChatLite> & { id: string }): ChatLite {
  return { title: over.id, spaceId: null, updatedAt: 0, ...over };
}
function artifact(over: Partial<ArtifactLite> & { id: string }): ArtifactLite {
  return { title: over.id, updatedAt: 0, ...over };
}
function space(over: Partial<SpaceLite> & { id: string }): SpaceLite {
  return { name: over.id, icon: null, position: 1, ...over };
}
/** Minimal PaletteResult factory for grouping tests. */
function res(kind: PaletteResult["kind"], id: string, score = 1): PaletteResult {
  return {
    kind,
    id: `${kind}:${id}`,
    title: id,
    icon: { type: "emoji", char: "x" },
    score,
    action: { type: "command", commandId: id },
  };
}
function emptyInput(): GroupInput {
  return { url: [], chat: [], artifact: [], space: [], command: [] };
}

describe("buildChatMatches", () => {
  it("returns recency-sorted list on empty query (for zero-state recents)", () => {
    const out = buildChatMatches("", [
      chat({ id: "old", updatedAt: 100 }),
      chat({ id: "new", updatedAt: 300 }),
      chat({ id: "mid", updatedAt: 200 }),
    ]);
    expect(out.map((r) => r.action)).toEqual([
      { type: "openChat", conversationId: "new" },
      { type: "openChat", conversationId: "mid" },
      { type: "openChat", conversationId: "old" },
    ]);
    expect(out[0].titleRanges).toBeUndefined();
  });

  it("filters to title matches and sorts by score when querying", () => {
    const out = buildChatMatches("deploy", [
      chat({ id: "a", title: "Deploy pipeline notes" }),
      chat({ id: "b", title: "Grocery list" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("chat:a");
    expect(out[0].titleRanges?.length).toBeGreaterThan(0);
  });

  it("falls back to 'Untitled chat' for blank titles", () => {
    const out = buildChatMatches("", [chat({ id: "x", title: "" })]);
    expect(out[0].title).toBe("Untitled chat");
  });
});

describe("buildArtifactMatches", () => {
  it("matches against description and id, not just title", () => {
    const arts: ArtifactLite[] = [
      artifact({ id: "linear-triage", title: "Triage board", description: "sorts issues" }),
      artifact({ id: "other", title: "Weather", description: "forecast" }),
    ];
    expect(buildArtifactMatches("issues", arts).map((r) => r.id)).toEqual([
      "artifact:linear-triage",
    ]);
    expect(buildArtifactMatches("triage", arts).map((r) => r.id)).toEqual([
      "artifact:linear-triage",
    ]);
  });

  it("uses the emoji icon when the manifest carries one", () => {
    const [r] = buildArtifactMatches("", [artifact({ id: "a", icon: "🎯" })]);
    expect(r.icon).toEqual({ type: "emoji", char: "🎯" });
  });
});

describe("buildSpaceMatches", () => {
  it("returns all spaces sorted by position on empty query (space-scope zero state)", () => {
    const out = buildSpaceMatches("", [
      space({ id: "b", name: "Beta", position: 2 }),
      space({ id: "a", name: "Alpha", position: 1 }),
    ]);
    expect(out.map((r) => r.action)).toEqual([
      { type: "switchSpace", spaceId: "a" },
      { type: "switchSpace", spaceId: "b" },
    ]);
  });
  it("matches space names", () => {
    const out = buildSpaceMatches("work", [space({ id: "work", name: "Work" }), space({ id: "home", name: "Home" })]);
    expect(out.map((r) => r.action)).toEqual([{ type: "switchSpace", spaceId: "work" }]);
  });
});

describe("commandToPaletteResult", () => {
  it("preserves incoming order via descending score", () => {
    const icon = (() => null) as unknown as ActionItem["icon"];
    const first = commandToPaletteResult({ id: "tidy", label: "Tidy tabs", icon, type: "action" }, 0);
    const second = commandToPaletteResult({ id: "settings", label: "Settings", icon, type: "action" }, 1);
    expect(first.score).toBeGreaterThan(second.score);
    expect(first.action).toEqual({ type: "command", commandId: "tidy" });
  });
});

describe("matchToPaletteResult", () => {
  it("adapts a URL match, preserving ranges and action", () => {
    const m = {
      id: "vercel.com",
      canonicalUrl: "vercel.com",
      url: "https://vercel.com",
      title: "Vercel",
      favicon: "f.ico",
      score: 42,
      source: "tab",
      extraSources: [],
      titleRanges: [[0, 3]],
      urlRanges: [],
      isShortcut: false,
      action: "switch",
    } as unknown as Match;
    const r = matchToPaletteResult(m);
    expect(r.kind).toBe("url");
    expect(r.id).toBe("url:vercel.com");
    expect(r.icon).toEqual({ type: "favicon", url: "f.ico" });
    expect(r.titleRanges).toEqual([[0, 3]]);
    expect(r.action).toEqual({ type: "url", match: m, urlAction: "switch" });
  });
});

describe("parseScope", () => {
  it.each([
    ["chat: deploy", "chat", "deploy"],
    ["art: triage", "artifact", "triage"],
    ["artifact: triage", "artifact", "triage"],
    ["space: work", "space", "work"],
    ["/settings", "command", "settings"],
  ] as const)("parses %s", (input, scope, rest) => {
    expect(parseScope(input)).toEqual({ scope, rest });
  });

  it("returns null scope for a plain query", () => {
    expect(parseScope("deploy pipeline")).toEqual({ scope: null, rest: "deploy pipeline" });
  });
});

describe("groupResults", () => {
  it("orders groups url → chat → artifact → space → command and omits empties", () => {
    const input = emptyInput();
    input.command = [res("command", "c1")];
    input.chat = [res("chat", "h1")];
    input.url = [res("url", "u1")];
    const groups = groupResults(input);
    expect(groups.map((g) => g.kind)).toEqual(["url", "chat", "command"]);
  });

  it("applies per-group caps and reports hasMore/total", () => {
    const input = emptyInput();
    input.url = Array.from({ length: 12 }, (_, i) => res("url", `u${i}`, 12 - i));
    const [g] = groupResults(input);
    expect(g.results).toHaveLength(8); // url cap
    expect(g.total).toBe(12);
    expect(g.hasMore).toBe(true);
  });

  it("expands a group past its cap when requested", () => {
    const input = emptyInput();
    input.chat = Array.from({ length: 6 }, (_, i) => res("chat", `c${i}`));
    const [g] = groupResults(input, { expanded: new Set(["chat"]) });
    expect(g.results).toHaveLength(6);
    expect(g.hasMore).toBe(false);
  });

  it("shows only the scoped group with the larger cap", () => {
    const input = emptyInput();
    input.url = [res("url", "u1")];
    input.chat = Array.from({ length: 10 }, (_, i) => res("chat", `c${i}`));
    const groups = groupResults(input, { scope: "chat" });
    expect(groups.map((g) => g.kind)).toEqual(["chat"]);
    expect(groups[0].results).toHaveLength(10); // under SCOPED_CAP
  });

  it("flattenGroups yields the linear focus order", () => {
    const input = emptyInput();
    input.url = [res("url", "u1")];
    input.chat = [res("chat", "c1"), res("chat", "c2")];
    expect(flattenGroups(groupResults(input)).map((r) => r.id)).toEqual([
      "url:u1",
      "chat:c1",
      "chat:c2",
    ]);
  });
});
