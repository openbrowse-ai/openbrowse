import { describe, expect, it } from "vitest";
import { groupArtifacts } from "../components/LibraryView";
import type { SavedArtifact } from "@/lib/artifacts/registry";

function createArtifact(id: string, favorite?: boolean): SavedArtifact {
  return {
    manifest: { id, title: id, tools: [] } as any,
    sidecar: { favorite } as any,
    html: "",
  };
}

describe("LibraryView", () => {
  it("groupArtifacts: separates favorites from others", () => {
    const items = [
      createArtifact("1", true),
      createArtifact("2", false),
      createArtifact("3"),
      createArtifact("4", true),
    ];
    
    expect(groupArtifacts(items)).toEqual({
      favorites: [items[0], items[3]],
      others: [items[1], items[2]],
    });
  });

  it("groupArtifacts: empty input yields empty partitions", () => {
    expect(groupArtifacts([])).toEqual({
      favorites: [],
      others: [],
    });
  });

  it("groupArtifacts: all-favorites list puts everything in favorites", () => {
    const items = [
      createArtifact("1", true),
      createArtifact("2", true),
    ];

    expect(groupArtifacts(items)).toEqual({
      favorites: [items[0], items[1]],
      others: [],
    });
  });

  it("groupArtifacts: no-favorites list puts everything in others", () => {
    const items = [
      createArtifact("1", false),
      createArtifact("2"),
    ];

    expect(groupArtifacts(items)).toEqual({
      favorites: [],
      others: [items[0], items[1]],
    });
  });
});
