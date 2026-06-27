import { describe, it, expect } from "vitest";
import { validateManifest, classifyMode, canonicalizeManifest, manifestVersion } from "../validate";
import type { ArtifactManifest } from "../manifest";

const valid: ArtifactManifest = {
  v: 1,
  id: "linear-triage",
  title: "Linear Triage",
  description: "Triage unassigned issues",
  tools: [
    { name: "mcp.linear.search_issues", mode: "read" },
    { name: "mcp.linear.update_issue", mode: "write" },
  ],
  network: ["api.openweathermap.org"],
};

import { CDN_REGISTRY } from "../cdn-registry";

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(valid)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("rejects v != 1", () => {
    const r = validateManifest({ ...valid, v: 2 } as never);
    expect(r.ok).toBe(false);
  });

  it("rejects non-kebab-case id", () => {
    const r = validateManifest({ ...valid, id: "Linear_Triage" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown tool prefix", () => {
    const r = validateManifest({
      ...valid,
      tools: [{ name: "fs.read", mode: "read" }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown cdn entry", () => {
    const r = validateManifest({ ...valid, cdns: ["bogus@1.0"] });
    expect(r.ok).toBe(false);
  });

  it("accepts every key that exists in the CDN registry", () => {
    const keys = Object.keys(CDN_REGISTRY);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(validateManifest({ ...valid, cdns: [key] }).ok).toBe(true);
    }
  });

  it("rejects mcp tool name with no tool segment", () => {
    const r = validateManifest({ ...valid, tools: [{ name: "mcp.linear", mode: "read" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects browser tool with three segments", () => {
    const r = validateManifest({ ...valid, tools: [{ name: "browser.foo.bar", mode: "read" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects network with scheme", () => {
    const r = validateManifest({ ...valid, network: ["https://x.com"] });
    expect(r.ok).toBe(false);
  });

  it("rejects network with path", () => {
    const r = validateManifest({ ...valid, network: ["x.com/path"] });
    expect(r.ok).toBe(false);
  });

  it("accepts a *.host wildcard in network", () => {
    expect(validateManifest({ ...valid, network: ["*.example.com"] }).ok).toBe(true);
    expect(validateManifest({ ...valid, network: ["*.com"] }).ok).toBe(true);
  });

  it("rejects malformed wildcards in network", () => {
    expect(validateManifest({ ...valid, network: ["*"] }).ok).toBe(false);
    expect(validateManifest({ ...valid, network: ["*.*"] }).ok).toBe(false);
    expect(validateManifest({ ...valid, network: ["*example.com"] }).ok).toBe(false);
  });

  it("rejects duplicate tool names (read+write would bypass approval)", () => {
    // checkAllowlist resolves by first match, so a read entry shadowing a write
    // entry of the same name would skip approvedWrites. Must be rejected here.
    const r = validateManifest({
      ...valid,
      tools: [
        { name: "mcp.linear.update_issue", mode: "read" },
        { name: "mcp.linear.update_issue", mode: "write" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("duplicates an earlier entry"))).toBe(true);
  });

  it("rejects duplicate tool names even with identical modes", () => {
    const r = validateManifest({
      ...valid,
      tools: [
        { name: "mcp.linear.search_issues", mode: "read" },
        { name: "mcp.linear.search_issues", mode: "read" },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("warns on read/write mode mismatch", () => {
    const r = validateManifest({
      ...valid,
      tools: [{ name: "mcp.linear.update_issue", mode: "read" }],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("update_issue"))).toBe(true);
  });

  it("accepts a manifest with an emoji icon", () => {
    expect(validateManifest({ ...valid, icon: "🐛" }).ok).toBe(true);
  });

  it("accepts a manifest with no icon (back-compat with pre-icon artifacts)", () => {
    // Older artifacts saved before icons were introduced must still load —
    // extractManifest runs them through validateManifest, so requiring `icon`
    // here would orphan every existing artifact in OPFS. The hard requirement
    // lives at the create_artifact tool boundary instead.
    const { icon: _icon, ...withoutIcon } = valid as { icon?: string } & typeof valid;
    expect(validateManifest(withoutIcon).ok).toBe(true);
  });

  it("rejects an empty icon", () => {
    expect(validateManifest({ ...valid, icon: "" }).ok).toBe(false);
  });

  it("rejects an icon longer than 32 chars", () => {
    expect(validateManifest({ ...valid, icon: "a".repeat(33) }).ok).toBe(false);
  });
});

describe("classifyMode", () => {
  it("classifies search_/list_/get_ as read", () => {
    expect(classifyMode("mcp.linear.search_issues")).toBe("read");
    expect(classifyMode("mcp.linear.list_teams")).toBe("read");
    expect(classifyMode("mcp.github.get_pull_request")).toBe("read");
  });
  it("classifies create_/update_/delete_ as write", () => {
    expect(classifyMode("mcp.linear.update_issue")).toBe("write");
    expect(classifyMode("mcp.github.create_issue")).toBe("write");
    expect(classifyMode("mcp.github.delete_branch")).toBe("write");
  });
  it("returns null when uncertain", () => {
    expect(classifyMode("mcp.linear.foo")).toBeNull();
  });
  it("classifies send_ as write", () => {
    expect(classifyMode("mcp.slack.send_message")).toBe("write");
  });
});

describe("manifestVersion", () => {
  it("is stable across key reordering", async () => {
    // Construct with literally different insertion orders.
    const a = {
      v: 1 as const, id: "x", title: "T", tools: [
        { name: "mcp.linear.search_issues", mode: "read" as const },
        { name: "mcp.linear.update_issue", mode: "write" as const },
      ],
      network: ["api.openweathermap.org"],
    };
    const b = {
      network: ["api.openweathermap.org"],
      tools: [
        { mode: "read" as const, name: "mcp.linear.search_issues" },
        { mode: "write" as const, name: "mcp.linear.update_issue" },
      ],
      title: "T",
      id: "x",
      v: 1 as const,
    };
    expect(await manifestVersion(canonicalizeManifest(a)))
      .toEqual(await manifestVersion(canonicalizeManifest(b)));
  });
  it("yields the same hash when title or description changes", async () => {
    const before = await manifestVersion(canonicalizeManifest(valid));
    const after = await manifestVersion(canonicalizeManifest({
      ...valid,
      title: "New Title",
      description: "New Description"
    }));
    expect(before).toEqual(after);
  });
  it("changes when a write tool is added", async () => {
    const before = await manifestVersion(canonicalizeManifest(valid));
    const after = await manifestVersion(
      canonicalizeManifest({
        ...valid,
        tools: [...valid.tools, { name: "mcp.linear.delete_issue", mode: "write" }],
      }),
    );
    expect(before).not.toEqual(after);
  });
  it("changes when a tool's name changes (not just count)", async () => {
    const before = await manifestVersion(canonicalizeManifest({
      v: 1, id: "x", title: "T",
      tools: [{ name: "mcp.linear.search_issues", mode: "read" }],
    }));
    const after = await manifestVersion(canonicalizeManifest({
      v: 1, id: "x", title: "T",
      tools: [{ name: "mcp.linear.list_issues", mode: "read" }],
    }));
    expect(before).not.toEqual(after);
  });
});
