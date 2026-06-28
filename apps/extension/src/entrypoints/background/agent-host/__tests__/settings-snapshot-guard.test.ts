import { describe, expect, it } from "vitest";
import { isAgentRunSettingsSnapshot } from "../bootstrap";

/**
 * The Port boundary between renderer and SW must reject malformed
 * `settingsSnapshot` payloads before they reach `createAgentTransport`.
 * The guard validates the full `AgentRunSettingsSnapshot` shape:
 *  - required: `agentModel: string`, `spaceId: string | null`
 *  - optional (typed if present): `thinkingEnabled: boolean`,
 *    `thinkingConfig: object`, `headless: { autoApprove: boolean }`
 */

describe("isAgentRunSettingsSnapshot", () => {
  it("accepts a minimal well-formed snapshot", () => {
    expect(
      isAgentRunSettingsSnapshot({ agentModel: "openai:gpt-5", spaceId: null }),
    ).toBe(true);
  });

  it("accepts a fully-populated snapshot", () => {
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "openai:gpt-5",
        spaceId: "space-1",
        thinkingEnabled: true,
        thinkingConfig: { budget: 4096 },
        headless: { autoApprove: false },
      }),
    ).toBe(true);
  });

  it("rejects missing agentModel", () => {
    expect(isAgentRunSettingsSnapshot({ spaceId: null })).toBe(false);
  });

  it("rejects non-string agentModel", () => {
    expect(
      isAgentRunSettingsSnapshot({ agentModel: 42, spaceId: null }),
    ).toBe(false);
  });

  it("rejects missing spaceId", () => {
    expect(isAgentRunSettingsSnapshot({ agentModel: "x:y" })).toBe(false);
  });

  it("rejects non-string/non-null spaceId", () => {
    expect(
      isAgentRunSettingsSnapshot({ agentModel: "x:y", spaceId: 7 }),
    ).toBe(false);
  });

  it("rejects malformed headless (missing autoApprove)", () => {
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "x:y",
        spaceId: null,
        headless: {},
      }),
    ).toBe(false);
  });

  it("rejects malformed headless (non-boolean autoApprove)", () => {
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "x:y",
        spaceId: null,
        headless: { autoApprove: "true" },
      }),
    ).toBe(false);
  });

  it("rejects non-boolean thinkingEnabled", () => {
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "x:y",
        spaceId: null,
        thinkingEnabled: "yes",
      }),
    ).toBe(false);
  });

  it("rejects non-object thinkingConfig (string)", () => {
    // `thinkingConfig` must be an object (or absent). Reject scalar
    // forms at the boundary so `createAgentTransport` doesn't read a
    // string as if it were a ThinkingConfig shape.
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "x:y",
        spaceId: null,
        thinkingConfig: "not-an-object",
      }),
    ).toBe(false);
  });

  it("rejects non-object thinkingConfig (number)", () => {
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "x:y",
        spaceId: null,
        thinkingConfig: 42,
      }),
    ).toBe(false);
  });

  it("rejects null thinkingConfig (must be object or absent)", () => {
    // The guard already checks `o.thinkingConfig === null` explicitly —
    // pin that contract.
    expect(
      isAgentRunSettingsSnapshot({
        agentModel: "x:y",
        spaceId: null,
        thinkingConfig: null,
      }),
    ).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isAgentRunSettingsSnapshot(null)).toBe(false);
    expect(isAgentRunSettingsSnapshot(undefined)).toBe(false);
    expect(isAgentRunSettingsSnapshot("foo")).toBe(false);
    expect(isAgentRunSettingsSnapshot(123)).toBe(false);
  });
});
