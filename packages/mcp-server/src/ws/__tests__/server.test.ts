import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

interface RunningServer {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<RunningServer> {
  const { startHttpServer } = await import("../../server");
  return startHttpServer({ port: 0 });
}

/**
 * Buffered message reader. Attaches a permanent "message" listener that
 * queues incoming messages. Each call to next() returns the next message
 * (already buffered or yet-to-arrive). This avoids the race where the
 * broker's hello-challenge arrives before the test can attach a one-shot
 * listener.
 */
function bufferedReader(ws: WebSocket) {
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString("utf8"));
    if ((parsed as { type?: string }).type === "ping") return;
    const w = waiters.shift();
    if (w) w(parsed);
    else queue.push(parsed);
  });
  return {
    next(): Promise<unknown> {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

describe("ws/server", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-mcp-ws-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("sends hello-challenge on connection and accepts hello-response", async () => {
    const server = await startTestServer();
    try {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
      const reader = bufferedReader(ws);
      await new Promise((r) => ws.once("open", r));

      const challenge = await reader.next();
      expect(challenge).toMatchObject({
        type: "hello-challenge",
        protocolVersion: 1,
      });
      expect(typeof (challenge as { nonce: string }).nonce).toBe("string");
      expect(typeof (challenge as { publicKeyFingerprint: string }).publicKeyFingerprint).toBe(
        "string",
      );

      ws.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 1,
          extensionVersion: "0.0.0-test",
          capabilities: { tools: ["get_context"], profile: "Default" },
        }),
      );

      const proof = await reader.next();
      expect(proof).toMatchObject({ type: "hello-proof" });
      expect(typeof (proof as { signature: string }).signature).toBe("string");
      expect(typeof (proof as { sessionId: string }).sessionId).toBe("string");

      ws.close();
    } finally {
      await server.close();
    }
  });

  it("rejects second connection while one is already paired", async () => {
    const server = await startTestServer();
    try {
      const ws1 = new WebSocket(`ws://localhost:${server.port}/ws`);
      const r1 = bufferedReader(ws1);
      await new Promise((r) => ws1.once("open", r));
      await r1.next(); // challenge
      ws1.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 1,
          extensionVersion: "0.0.0",
          capabilities: { tools: [], profile: "Default" },
        }),
      );
      await r1.next(); // hello-proof

      // Second connection should be rejected
      const ws2 = new WebSocket(`ws://localhost:${server.port}/ws`);
      const r2 = bufferedReader(ws2);
      await new Promise((r) => ws2.once("open", r));
      await r2.next(); // challenge
      ws2.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 1,
          extensionVersion: "0.0.0",
          capabilities: { tools: [], profile: "Default" },
        }),
      );
      const second = await r2.next();
      expect(second).toMatchObject({
        type: "hello-reject",
        reason: "session_already_active",
      });

      ws1.close();
      ws2.close();
    } finally {
      await server.close();
    }
  });

  it("rejects mismatched protocol version", async () => {
    const server = await startTestServer();
    try {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
      const reader = bufferedReader(ws);
      await new Promise((r) => ws.once("open", r));
      await reader.next(); // challenge

      ws.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 99,
          extensionVersion: "0.0.0",
          capabilities: { tools: [], profile: "Default" },
        }),
      );
      const reject = await reader.next();
      expect(reject).toMatchObject({
        type: "hello-reject",
        reason: "protocol_version_unsupported",
      });
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("handles revoke-host by deleting refresh tokens for the clientId", async () => {
    // Phase 3 / Task 11: when the extension sends a `revoke-host`
    // message after the hello handshake, the broker invokes
    // `refreshTokens.revokeClient(clientId)`. We use the running
    // server's refresh-token store (exposed via `startHttpServer`'s
    // return value) so this exercises the full plumbing.
    const { startHttpServer } = await import("../../server");
    const server = await startHttpServer({ port: 0 });
    try {
      // Seed a couple of tokens so we can observe deletion.
      const t1 = server.refreshTokens.issue({ clientId: "c-revoke", scope: "openbrowse" });
      const t2 = server.refreshTokens.issue({ clientId: "c-keep", scope: "openbrowse" });

      const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
      const reader = bufferedReader(ws);
      await new Promise((r) => ws.once("open", r));
      await reader.next(); // challenge
      ws.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 1,
          extensionVersion: "0.0.0",
          capabilities: { tools: [], profile: "Default" },
        }),
      );
      await reader.next(); // hello-proof

      // Send the revocation. The broker has no reply for this message,
      // so we just wait for it to take effect.
      ws.send(JSON.stringify({ type: "revoke-host", clientId: "c-revoke" }));

      // Poll briefly for the redeem to fail (the server processes the
      // message on its own microtask). 200ms is comfortably above the
      // node IO scheduling jitter we see in CI.
      const deadline = Date.now() + 500;
      let revokedRedeem = server.refreshTokens.redeem(t1);
      while (revokedRedeem.ok && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        revokedRedeem = server.refreshTokens.redeem(t1);
      }
      expect(revokedRedeem.ok).toBe(false);

      // The unrelated token is still redeemable (until consumed).
      const keptRedeem = server.refreshTokens.redeem(t2);
      expect(keptRedeem.ok).toBe(true);

      ws.close();
    } finally {
      await server.close();
    }
  });

  it("sends heartbeat pings after session is established", async () => {
    const server = await startTestServer();
    try {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
      const allMessages: unknown[] = [];
      ws.on("message", (data) => {
        allMessages.push(JSON.parse(data.toString("utf8")));
      });
      await new Promise((r) => ws.once("open", r));

      // Complete handshake
      await new Promise((r) => setTimeout(r, 50));
      ws.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 1,
          extensionVersion: "0.0.0",
          capabilities: { tools: [], profile: "Default" },
        }),
      );

      // Wait just over 20s for the first heartbeat ping
      await new Promise((r) => setTimeout(r, 21_000));
      const pings = allMessages.filter(
        (m) => (m as { type: string }).type === "ping",
      );
      expect(pings.length).toBeGreaterThanOrEqual(1);
      expect((pings[0] as { ts: number }).ts).toBeGreaterThan(0);

      ws.close();
    } finally {
      await server.close();
    }
  }, 25_000);

  it("ignores revoke-host messages with unparseable JSON or wrong type", async () => {
    const { startHttpServer } = await import("../../server");
    const server = await startHttpServer({ port: 0 });
    try {
      const t = server.refreshTokens.issue({ clientId: "c-unaffected", scope: "openbrowse" });

      const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
      const reader = bufferedReader(ws);
      await new Promise((r) => ws.once("open", r));
      await reader.next(); // challenge
      ws.send(
        JSON.stringify({
          type: "hello-response",
          protocolVersion: 1,
          extensionVersion: "0.0.0",
          capabilities: { tools: [], profile: "Default" },
        }),
      );
      await reader.next(); // hello-proof

      // Garbage payload — should be silently dropped.
      ws.send("{ not json");
      // Wrong-type payload — should also be ignored.
      ws.send(JSON.stringify({ type: "totally-unknown", clientId: "c-unaffected" }));

      // Give the server a moment to (not) react.
      await new Promise((r) => setTimeout(r, 50));

      // Token is still redeemable.
      expect(server.refreshTokens.redeem(t).ok).toBe(true);

      ws.close();
    } finally {
      await server.close();
    }
  });
});
