import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.resetModules();
});

describe("mcp-bridge/consent", () => {
  it("handleConsentDecision('allow') sends consent-granted over WS and returns the redirect URL", async () => {
    const { handleConsentDecision } = await import("../consent");
    const ws = new FakeSocket();
    const result = await handleConsentDecision({
      decision: "allow",
      state: "s1",
      redirectUrlWithCode: "http://127.0.0.1:9999/cb?code=abc&state=s1",
      ws: ws as unknown as WebSocket,
    });
    expect(result.ok).toBe(true);
    expect(result.redirectUrl).toBe("http://127.0.0.1:9999/cb?code=abc&state=s1");
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: "consent-granted", state: "s1" });
  });

  it("handleConsentDecision('deny') sends consent-denied and returns redirect_uri with error=access_denied", async () => {
    const { handleConsentDecision } = await import("../consent");
    const ws = new FakeSocket();
    const result = await handleConsentDecision({
      decision: "deny",
      state: "s1",
      redirectUrlWithCode: "http://127.0.0.1:9999/cb?code=abc&state=s1",
      ws: ws as unknown as WebSocket,
    });
    expect(result.ok).toBe(true);
    expect(result.redirectUrl).toMatch(/error=access_denied/);
    expect(result.redirectUrl).not.toContain("code=");
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: "consent-denied", state: "s1" });
  });

  it("handleConsentDecision tolerates a missing WS (broker disconnected)", async () => {
    const { handleConsentDecision } = await import("../consent");
    const result = await handleConsentDecision({
      decision: "allow",
      state: "s1",
      redirectUrlWithCode: "http://127.0.0.1:9999/cb?code=abc&state=s1",
      ws: null,
    });
    expect(result.ok).toBe(true);
    expect(result.redirectUrl).toBe("http://127.0.0.1:9999/cb?code=abc&state=s1");
  });

  it("handleConsentDecision('deny') with malformed URL returns ok=false and passes URL through", async () => {
    const { handleConsentDecision } = await import("../consent");
    const ws = new FakeSocket();
    // Suppress the expected console.warn in this test
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await handleConsentDecision({
      decision: "deny",
      state: "s1",
      redirectUrlWithCode: "not a valid url",
      ws: ws as unknown as WebSocket,
    });
    expect(result.ok).toBe(false);
    expect(result.redirectUrl).toBe("not a valid url");
    warnSpy.mockRestore();
  });
});
