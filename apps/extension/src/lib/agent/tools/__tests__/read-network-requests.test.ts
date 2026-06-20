import { describe, expect, it } from "vitest";
import { readNetworkRequestsTool } from "../read-network-requests";

describe("read_network_requests schema", () => {
  it("requires `tab`", () => {
    expect(readNetworkRequestsTool.parameters.safeParse({}).success).toBe(false);
  });
  it("accepts `tab` plus optional filters", () => {
    const r = readNetworkRequestsTool.parameters.safeParse({
      tab: "t1", urlPattern: "/api/", limit: 50, clear: true,
    });
    expect(r.success).toBe(true);
  });
  it("does not require approval", () => {
    expect(readNetworkRequestsTool.approval?.required ?? false).toBe(false);
  });
});
