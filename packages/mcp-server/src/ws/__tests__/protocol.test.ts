import { describe, expect, it } from "vitest";

describe("ws/protocol", () => {
  it("exports type guards for each message kind", async () => {
    const protocol = await import("../protocol");
    expect(typeof protocol.isHelloChallenge).toBe("function");
    expect(typeof protocol.isHelloResponse).toBe("function");
    expect(typeof protocol.isHelloProof).toBe("function");
    expect(typeof protocol.isHelloReject).toBe("function");
    expect(typeof protocol.isRpcRequest).toBe("function");
    expect(typeof protocol.isRpcResult).toBe("function");
    expect(typeof protocol.isRpcError).toBe("function");
    expect(typeof protocol.isTaskEvent).toBe("function");
    expect(typeof protocol.isAuditEvent).toBe("function");
    expect(typeof protocol.isConsentGranted).toBe("function");
    expect(typeof protocol.isConsentDenied).toBe("function");
  });

  it("PROTOCOL_VERSION is 1", async () => {
    const protocol = await import("../protocol");
    expect(protocol.PROTOCOL_VERSION).toBe(1);
  });

  it("isHelloChallenge recognises valid message", async () => {
    const { isHelloChallenge } = await import("../protocol");
    expect(
      isHelloChallenge({
        type: "hello-challenge",
        protocolVersion: 1,
        brokerVersion: "0.0.0",
        publicKeyFingerprint: "abc",
        processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
        nonce: "n",
      }),
    ).toBe(true);
    expect(isHelloChallenge({ type: "other" })).toBe(false);
  });

  it("isTaskEvent recognises a step-start payload", async () => {
    const { isTaskEvent } = await import("../protocol");
    expect(
      isTaskEvent({
        type: "task-event",
        id: "rpc1",
        step: 1,
        event: { kind: "step-start", toolName: "screenshot", argsPreview: "tab=t1" },
      }),
    ).toBe(true);
    expect(isTaskEvent({ type: "rpc-result", id: "x", result: {} })).toBe(false);
  });

  it("isAuditEvent recognises an entry", async () => {
    const { isAuditEvent } = await import("../protocol");
    expect(isAuditEvent({
      type: "audit-event",
      entry: { seq: 1, ts: 0, clientId: "c1", hostName: "Cursor", method: "read_page", durationMs: 12, outcome: "ok" },
    })).toBe(true);
    expect(isAuditEvent({ type: "rpc-result", id: "x", result: {} })).toBe(false);
  });
});
