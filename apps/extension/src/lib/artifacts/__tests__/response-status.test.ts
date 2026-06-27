// apps/extension/src/lib/artifacts/__tests__/response-status.test.ts
import { describe, it, expect } from "vitest";
import { isNullBodyStatus, bodyForStatus, NULL_BODY_STATUSES } from "../response-status";
import { BRIDGE_SHIM_SOURCE } from "@/entrypoints/artifact/bridge-shim";

describe("response-status", () => {
  it("treats 101/204/205/304 as null-body statuses", () => {
    for (const s of [101, 204, 205, 304]) expect(isNullBodyStatus(s)).toBe(true);
  });

  it("treats normal statuses as body-bearing", () => {
    for (const s of [200, 201, 206, 301, 302, 400, 404, 500]) {
      expect(isNullBodyStatus(s)).toBe(false);
    }
  });

  it("nulls the body for null-body statuses, preserves it otherwise", () => {
    const body = new ArrayBuffer(8);
    expect(bodyForStatus(204, body)).toBeNull();
    expect(bodyForStatus(304, body)).toBeNull();
    expect(bodyForStatus(200, body)).toBe(body);
  });

  // Guard the contract between this module and the inline shim logic: the shim
  // must drop the body for exactly these statuses. If someone changes one and
  // not the other, this fails.
  it("the bridge shim drops the body for the same status set", () => {
    for (const s of NULL_BODY_STATUSES) {
      expect(BRIDGE_SHIM_SOURCE).toContain(`result.status === ${s}`);
    }
    expect(BRIDGE_SHIM_SOURCE).toContain("nullBodyStatus ? null : bufFromB64");
  });
});
