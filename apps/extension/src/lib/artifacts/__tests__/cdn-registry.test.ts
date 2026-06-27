import { describe, it, expect } from "vitest";
import { CDN_REGISTRY, getCdn } from "../cdn-registry";

describe("CDN_REGISTRY", () => {
  it("exposes the four advertised CDN keys", () => {
    // These keys are advertised to the agent in the create_artifact tool
    // description and the authoring-artifacts skill. Keep them in sync — a
    // missing key here means the agent is told to use a CDN that fails
    // validateManifest.
    expect(Object.keys(CDN_REGISTRY).sort()).toEqual(
      ["chartjs@4.5", "d3@7", "gridjs@5.0.2", "mermaid@11.10"].sort(),
    );
  });

  it("every entry has self-consistent fields, a pinned URL, and an sha384 SRI", () => {
    for (const [key, entry] of Object.entries(CDN_REGISTRY)) {
      // entry.key must match its map key (used as the manifest cdns[] string).
      expect(entry.key).toBe(key);

      // URL must be an absolute https jsdelivr URL.
      const u = new URL(entry.url);
      expect(u.protocol).toBe("https:");

      // SRI must be a sha384 hash (base64), not a placeholder.
      expect(entry.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
      expect(entry.integrity).not.toBe("sha384-TEST");

      // URL must be version-pinned (contains an explicit @<version>) so the
      // SRI hash can't break when the CDN serves a newer build. We check the
      // path carries a digit-bearing @version segment.
      expect(entry.url).toMatch(/@\d+\.\d+/);
    }
  });

  it("getCdn resolves known keys and returns undefined otherwise", () => {
    expect(getCdn("chartjs@4.5")?.key).toBe("chartjs@4.5");
    expect(getCdn("nope@0")).toBeUndefined();
  });
});
