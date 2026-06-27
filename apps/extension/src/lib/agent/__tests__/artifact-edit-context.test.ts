import { describe, it, expect } from "vitest";
import { buildEditingArtifactBlock } from "../artifact-edit-context";
import type { SavedArtifact } from "@/lib/artifacts/registry";

function artifact(overrides: Partial<SavedArtifact["manifest"]> = {}, html = "<html><body>OLD</body></html>"): SavedArtifact {
  return {
    manifest: {
      v: 1,
      id: "linear-triage",
      title: "Linear Triage",
      tools: [{ name: "mcp.linear.list_issues", mode: "read" }],
      ...overrides,
    },
    sidecar: {
      id: "linear-triage",
      createdAt: "t",
      updatedAt: "t",
      approvedWrites: [],
      approvedNetwork: [],
      manifestVersion: "v",
    },
    html,
  };
}

describe("buildEditingArtifactBlock", () => {
  it("embeds the current HTML as the source of truth", () => {
    const block = buildEditingArtifactBlock(artifact({}, "<html><body>HELLO</body></html>"));
    expect(block).toContain("### Editing Artifact");
    expect(block).toContain("```html");
    expect(block).toContain("<body>HELLO</body>");
  });

  it("instructs the agent to update via update_artifact edits with the id", () => {
    const block = buildEditingArtifactBlock(artifact());
    expect(block).toContain('update_artifact({ id: "linear-triage", edits:');
  });

  it("steers the agent away from filesystem/browser lookups", () => {
    const block = buildEditingArtifactBlock(artifact());
    expect(block).toMatch(/Do NOT use Read, Glob, LS/);
    expect(block).toMatch(/not on disk in this conversation/);
  });

  it("includes manifest tools and conditionally cdns/network", () => {
    const withExtras = buildEditingArtifactBlock(
      artifact({ cdns: ["d3@7"], network: ["api.example.com"] }),
    );
    expect(withExtras).toContain("Manifest tools:");
    expect(withExtras).toContain("d3@7");
    expect(withExtras).toContain("api.example.com");

    const without = buildEditingArtifactBlock(artifact());
    expect(without).not.toContain("CDNs:");
    expect(without).not.toContain("Network:");
  });
});
