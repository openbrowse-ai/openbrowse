import { describe, expect, it } from "vitest";
import {
  BUILTIN_SLASH_COMMANDS,
  isBuiltinSlashCommand,
  matchBuiltinCommands,
} from "../slash-commands";

describe("BUILTIN_SLASH_COMMANDS", () => {
  it("includes the compact command", () => {
    const compact = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "compact");
    expect(compact).toBeDefined();
    expect(compact?.description.length).toBeGreaterThan(0);
  });
});

describe("isBuiltinSlashCommand", () => {
  it("returns true for a known command name", () => {
    expect(isBuiltinSlashCommand("compact")).toBe(true);
  });

  it("is case-sensitive to the canonical name", () => {
    // Commands are lowercase; mention names are normalised lowercase too.
    expect(isBuiltinSlashCommand("Compact")).toBe(false);
  });

  it("returns false for unknown names", () => {
    expect(isBuiltinSlashCommand("not-a-command")).toBe(false);
    expect(isBuiltinSlashCommand("")).toBe(false);
  });
});

describe("matchBuiltinCommands", () => {
  it("returns all commands for an empty query", () => {
    expect(matchBuiltinCommands("")).toEqual(BUILTIN_SLASH_COMMANDS);
  });

  it("filters by name prefix/substring", () => {
    const result = matchBuiltinCommands("comp");
    expect(result.map((c) => c.name)).toContain("compact");
  });

  it("filters by description substring", () => {
    const result = matchBuiltinCommands("summarize");
    expect(result.map((c) => c.name)).toContain("compact");
  });

  it("is case-insensitive", () => {
    expect(matchBuiltinCommands("COMPACT").map((c) => c.name)).toContain(
      "compact",
    );
  });

  it("returns empty for a non-matching query", () => {
    expect(matchBuiltinCommands("zzzzz")).toEqual([]);
  });
});
