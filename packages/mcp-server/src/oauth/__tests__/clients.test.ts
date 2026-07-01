import { describe, expect, it } from "vitest";

describe("oauth/clients", () => {
  it("registers a client with redirect_uris and returns a client_id", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const result = reg.register({
      client_name: "Test Client",
      redirect_uris: ["http://127.0.0.1:9999/callback"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.client.client_id).toBe("string");
      expect(result.client.client_name).toBe("Test Client");
      expect(result.client.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
    }
  });

  it("rejects registration with no redirect_uris", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const result = reg.register({ client_name: "X", redirect_uris: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_redirect_uri");
  });

  it("lookup by client_id returns the registered client", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const r = reg.register({ client_name: "C", redirect_uris: ["http://localhost:8080/cb"] });
    if (!r.ok) throw new Error("setup");
    const found = reg.get(r.client.client_id);
    expect(found?.client_name).toBe("C");
  });

  it("lookup of unknown client_id returns undefined", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    expect(reg.get("missing")).toBeUndefined();
  });
});
