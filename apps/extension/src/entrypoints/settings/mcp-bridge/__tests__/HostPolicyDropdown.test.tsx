import { describe, expect, it } from "vitest";
import {
  buildSetPolicyMessage,
  POLICY_OPTIONS,
  policyDescription,
} from "../HostPolicyDropdown";

/**
 * The full HostPolicyDropdown component is JSX + change handlers. The
 * project doesn't pull in @testing-library/react and vitest runs in
 * the node env, so we test the extracted pure helpers (the
 * message-shape builder, the constant option list, the description
 * lookup) instead.
 */
describe("HostPolicyDropdown — buildSetPolicyMessage", () => {
  it("builds the set-policy message for always-prompt", () => {
    expect(buildSetPolicyMessage("c1", "always-prompt")).toEqual({
      type: "MCP_BRIDGE_SET_POLICY",
      clientId: "c1",
      policy: "always-prompt",
    });
  });

  it("builds the set-policy message for auto-allow", () => {
    expect(buildSetPolicyMessage("c1", "auto-allow")).toEqual({
      type: "MCP_BRIDGE_SET_POLICY",
      clientId: "c1",
      policy: "auto-allow",
    });
  });

  it("builds the set-policy message for blocked", () => {
    expect(buildSetPolicyMessage("c2", "blocked")).toEqual({
      type: "MCP_BRIDGE_SET_POLICY",
      clientId: "c2",
      policy: "blocked",
    });
  });
});

describe("HostPolicyDropdown — POLICY_OPTIONS", () => {
  it("exposes exactly three options in the documented order", () => {
    // Order matters: `auto-allow` is the post-OAuth default
    // (2026-06-29) so it appears first to match the most common
    // state. A previous ordering put `always-prompt` first when
    // that was the default; this test guards against an accidental
    // revert.
    expect(POLICY_OPTIONS.map((o) => o.value)).toEqual([
      "auto-allow",
      "always-prompt",
      "blocked",
    ]);
  });

  it("uses non-technical labels (no jargon)", () => {
    const byValue = Object.fromEntries(
      POLICY_OPTIONS.map((o) => [o.value, o.label]),
    );
    expect(byValue["auto-allow"]).toBe("Trust automatically");
    expect(byValue["always-prompt"]).toBe("Ask every time");
    expect(byValue["blocked"]).toBe("Blocked");
  });
});

describe("HostPolicyDropdown — policyDescription", () => {
  it("explains auto-allow as no-prompt", () => {
    expect(policyDescription("auto-allow")).toMatch(/without asking/);
  });
  it("explains always-prompt as requires approval", () => {
    expect(policyDescription("always-prompt")).toMatch(/requires your approval/);
  });
  it("explains blocked as cannot do anything", () => {
    expect(policyDescription("blocked")).toMatch(/cannot do anything/);
  });
});
