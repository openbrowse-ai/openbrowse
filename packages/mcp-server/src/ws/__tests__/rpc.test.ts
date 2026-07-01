import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket as WsWebSocket } from "ws";

// Fake WebSocket — extends EventEmitter to capture .send and emit
// inbound messages programmatically.
class FakeWs extends EventEmitter {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

describe("ws/rpc", () => {
  it("forwards RPC over WS and resolves with response", async () => {
    const { createRpcForwarder } = await import("../rpc");
    const { SessionRegistry } = await import("../session");
    const reg = new SessionRegistry();
    const ws = new FakeWs();
    reg.setSession({
      ws: ws as unknown as WsWebSocket,
      sessionId: "s",
      extensionVersion: "x",
      capabilities: { tools: ["get_context"], profile: "Default" },
      connectedAt: 0,
    });
    const forwarder = createRpcForwarder(reg);

    const callPromise = forwarder("get_context", {}, { sub: "client1", scope: "list_windows", client_name: "Test" });

    // Verify the broker sent the right rpc envelope
    expect(ws.sent.length).toBe(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("rpc");
    expect(sent.method).toBe("get_context");
    expect(sent.hostInfo).toEqual({ name: "Test", version: "" });
    expect(typeof sent.id).toBe("string");

    // Reply via the fake WS
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "rpc-result",
      id: sent.id,
      result: { focusedWindowId: 1, windows: [], brokerVersion: "0", extensionVersion: "0" },
    })));

    const result = await callPromise;
    expect(result).toMatchObject({ focusedWindowId: 1, windows: [] });
  });

  it("rejects when extension is not connected", async () => {
    const { createRpcForwarder } = await import("../rpc");
    const { SessionRegistry } = await import("../session");
    const reg = new SessionRegistry();
    const forwarder = createRpcForwarder(reg);
    await expect(
      forwarder("get_context", {}, { sub: "c", client_name: "T", scope: "x" }),
    ).rejects.toThrow(/not connected/i);
  });

  it("propagates rpc-error as exception", async () => {
    const { createRpcForwarder } = await import("../rpc");
    const { SessionRegistry } = await import("../session");
    const reg = new SessionRegistry();
    const ws = new FakeWs();
    reg.setSession({
      ws: ws as unknown as WsWebSocket,
      sessionId: "s",
      extensionVersion: "x",
      capabilities: { tools: ["x"], profile: "Default" },
      connectedAt: 0,
    });
    const forwarder = createRpcForwarder(reg);

    const callPromise = forwarder("get_context", {}, { sub: "c", client_name: "T", scope: "x" });
    const sent = JSON.parse(ws.sent[0]);
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "rpc-error",
      id: sent.id,
      error: { code: "tab_not_found", message: "no" },
    })));

    await expect(callPromise).rejects.toThrow(/tab_not_found/);
  });

  it("aborts a pending RPC when AbortSignal fires", async () => {
    const { createRpcForwarder } = await import("../rpc");
    const { SessionRegistry } = await import("../session");
    const reg = new SessionRegistry();
    const ws = new FakeWs();
    reg.setSession({
      ws: ws as unknown as WsWebSocket,
      sessionId: "s",
      extensionVersion: "x",
      capabilities: { tools: ["x"], profile: "Default" },
      connectedAt: 0,
    });
    const forwarder = createRpcForwarder(reg);

    const ac = new AbortController();
    const callPromise = forwarder("get_context", {}, {
      sub: "c", client_name: "T", scope: "x", signal: ac.signal,
    });
    // Pre-abort fires
    ac.abort();
    await expect(callPromise).rejects.toThrow(/aborted/i);
  });
});
