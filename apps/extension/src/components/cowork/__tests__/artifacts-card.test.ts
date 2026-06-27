import { describe, it, expect } from "vitest";
import { artifactsForConversation } from "../artifacts-card";
import type { SavedArtifact } from "@/lib/artifacts/registry";

function artifact(id: string, sourceConversationId: string | undefined): SavedArtifact {
  return {
    manifest: { v: 1, id, title: id, tools: [] },
    sidecar: {
      id,
      createdAt: "t",
      updatedAt: "t",
      approvedWrites: [],
      approvedNetwork: [],
      manifestVersion: "v",
      sourceConversationId,
    },
    html: "<html></html>",
  };
}

describe("artifactsForConversation", () => {
  it("keeps only artifacts whose sidecar.sourceConversationId matches", () => {
    const all = [
      artifact("a", "conv-1"),
      artifact("b", "conv-2"),
      artifact("c", "conv-1"),
    ];
    const out = artifactsForConversation(all, "conv-1");
    expect(out.map((a) => a.manifest.id)).toEqual(["a", "c"]);
  });

  it("excludes artifacts with no source conversation", () => {
    const all = [artifact("a", undefined), artifact("b", "conv-1")];
    expect(artifactsForConversation(all, "conv-1").map((a) => a.manifest.id)).toEqual(["b"]);
  });

  it("returns empty when nothing matches", () => {
    const all = [artifact("a", "conv-2")];
    expect(artifactsForConversation(all, "conv-1")).toEqual([]);
  });
});
