import { describe, expect, it } from "vitest";
import {
  AUTO_DENY_OPTIONS,
  resolveSelectedValue,
} from "../AutoDenyTimeoutSelect";

describe("AutoDenyTimeoutSelect — options", () => {
  it("exposes 30s/1m/2m/5m/Never in order", () => {
    expect(AUTO_DENY_OPTIONS.map((o) => o.value)).toEqual([
      30_000,
      60_000,
      120_000,
      300_000,
      0,
    ]);
  });

  it("pairs every value with a non-empty human label", () => {
    for (const opt of AUTO_DENY_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });
});

describe("AutoDenyTimeoutSelect — resolveSelectedValue", () => {
  it("returns the stored value when set", () => {
    expect(resolveSelectedValue(30_000)).toBe(30_000);
    expect(resolveSelectedValue(0)).toBe(0);
  });
  it("defaults undefined to 60_000 (the historical default)", () => {
    expect(resolveSelectedValue(undefined)).toBe(60_000);
  });
});
