import { describe, it, expect } from "vitest";
import { isHostAllowed } from "../network-allowlist";

describe("isHostAllowed", () => {
  it("matches an exact host", () => {
    expect(isHostAllowed("example.com", ["example.com"])).toBe(true);
  });

  it("does not match a subdomain against an exact entry", () => {
    expect(isHostAllowed("api.example.com", ["example.com"])).toBe(false);
  });

  it("matches a subdomain against a wildcard entry", () => {
    expect(isHostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(isHostAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
  });

  it("does not match the bare host against a wildcard entry", () => {
    expect(isHostAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isHostAllowed("API.Example.COM", ["*.example.com"])).toBe(true);
    expect(isHostAllowed("Example.com", ["EXAMPLE.COM"])).toBe(true);
  });

  it("does not partial-suffix-match without a dot boundary", () => {
    // notexample.com must not match *.example.com
    expect(isHostAllowed("notexample.com", ["*.example.com"])).toBe(false);
    // evilexample.com must not match example.com
    expect(isHostAllowed("evilexample.com", ["example.com"])).toBe(false);
  });

  it("checks every allowlist entry", () => {
    expect(isHostAllowed("api.linear.app", ["news.google.com", "*.linear.app"])).toBe(true);
  });

  it("returns false for empty / invalid input", () => {
    expect(isHostAllowed("", ["example.com"])).toBe(false);
    expect(isHostAllowed("example.com", [])).toBe(false);
    expect(isHostAllowed("example.com", ["", "*."])).toBe(false);
  });
});
