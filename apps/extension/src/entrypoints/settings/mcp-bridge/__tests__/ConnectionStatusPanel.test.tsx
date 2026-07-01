import { describe, expect, it } from "vitest";
import {
  buildAcceptTofuMessage,
  buildClearTrustMessage,
  buildDeclineTofuMessage,
  buildForceReconnectMessage,
  formatFingerprint,
  formatRelative,
  shortHash,
  statusPillFor,
} from "../ConnectionStatusPanel";

describe("ConnectionStatusPanel — message builders", () => {
  it("builds MCP_BRIDGE_ACCEPT_TOFU", () => {
    expect(buildAcceptTofuMessage()).toEqual({ type: "MCP_BRIDGE_ACCEPT_TOFU" });
  });
  it("builds MCP_BRIDGE_DECLINE_TOFU", () => {
    expect(buildDeclineTofuMessage()).toEqual({ type: "MCP_BRIDGE_DECLINE_TOFU" });
  });
  it("builds MCP_BRIDGE_CLEAR_TRUST", () => {
    expect(buildClearTrustMessage()).toEqual({ type: "MCP_BRIDGE_CLEAR_TRUST" });
  });
  it("builds MCP_BRIDGE_FORCE_RECONNECT", () => {
    expect(buildForceReconnectMessage()).toEqual({ type: "MCP_BRIDGE_FORCE_RECONNECT" });
  });
});

describe("ConnectionStatusPanel — formatFingerprint", () => {
  it("inserts colons between hex pairs", () => {
    expect(formatFingerprint("aabbccdd")).toBe("aa:bb:cc:dd");
  });
  it("preserves odd-length input verbatim by padding the last group", () => {
    // Last group ends up as a single char — by design we don't drop or
    // pad; "aa:bb:c" is what comes out of /.{1,2}/g.
    expect(formatFingerprint("aabbc")).toBe("aa:bb:c");
  });
  it("returns the input unchanged for the empty string", () => {
    expect(formatFingerprint("")).toBe("");
  });
});

describe("ConnectionStatusPanel — shortHash", () => {
  it("truncates middle of long hashes", () => {
    const hex = "0".repeat(8) + "x".repeat(48) + "1".repeat(8);
    expect(shortHash(hex)).toBe("00000000…11111111");
  });
  it("returns short inputs unchanged", () => {
    expect(shortHash("abc")).toBe("abc");
    // Boundary: 20 chars exactly is the "short" cutoff.
    const twenty = "12345678901234567890";
    expect(shortHash(twenty)).toBe(twenty);
  });
});

describe("ConnectionStatusPanel — formatRelative", () => {
  const NOW = 1_700_000_000_000;
  it("renders seconds for sub-minute deltas", () => {
    expect(formatRelative(NOW - 5_000, NOW)).toBe("5s ago");
    expect(formatRelative(NOW - 59_999, NOW)).toBe("59s ago");
  });
  it("renders minutes for sub-hour deltas", () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatRelative(NOW - 30 * 60_000, NOW)).toBe("30m ago");
  });
  it("renders hours for sub-day deltas", () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe("1h ago");
    expect(formatRelative(NOW - 23 * 60 * 60_000, NOW)).toBe("23h ago");
  });
  it("renders days past 24h", () => {
    const DAY = 24 * 60 * 60_000;
    expect(formatRelative(NOW - DAY, NOW)).toBe("1d ago");
    expect(formatRelative(NOW - 3 * DAY, NOW)).toBe("3d ago");
  });
  it("clamps negative deltas (clock skew) to 0s", () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe("0s ago");
  });
});

describe("ConnectionStatusPanel — statusPillFor", () => {
  it("returns green Ready for connected", () => {
    expect(
      statusPillFor({
        kind: "connected",
        brokerVersion: "v",
        sessionId: "s",
        connectedAt: 0,
      }),
    ).toEqual({ label: "Ready", color: "green" });
  });

  it("returns gray Connecting for connecting", () => {
    expect(statusPillFor({ kind: "connecting", attempt: 1 })).toEqual({
      label: "Connecting…",
      color: "gray",
    });
  });

  it("returns gray Not connected for disconnected", () => {
    expect(statusPillFor({ kind: "disconnected" })).toEqual({
      label: "Not connected",
      color: "gray",
    });
  });

  it("returns amber Needs your approval for awaiting_tofu", () => {
    expect(
      statusPillFor({
        kind: "awaiting_tofu",
        prompt: {
          fingerprint: "fp",
          processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
          nonce: "n",
        },
      }),
    ).toEqual({ label: "Needs your approval", color: "amber" });
  });

  it("returns red MCP helper key changed for key_mismatch", () => {
    expect(
      statusPillFor({
        kind: "key_mismatch",
        storedFingerprint: "old",
        presentedFingerprint: "new",
      }),
    ).toEqual({ label: "MCP helper key changed", color: "red" });
  });
});
