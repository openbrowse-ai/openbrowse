import { describe, it, expect, vi } from "vitest";

const cdnReg = vi.hoisted(() => ({
  CDN_REGISTRY: {
    "chartjs@4.5": {
      key: "chartjs@4.5",
      url: "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js",
      integrity: "sha384-TEST",
    },
  },
}));
vi.mock("../cdn-registry", () => cdnReg);

import { buildCsp } from "../csp";

describe("buildCsp", () => {
  it("uses connect-src 'none' when network is empty", () => {
    const csp = buildCsp({ network: [], cdns: [] });
    expect(csp).toMatch(/connect-src 'none'/);
  });

  it("adds https:// hostnames from network[]", () => {
    const csp = buildCsp({ network: ["api.example.com", "x.y.z"], cdns: [] });
    expect(csp).toMatch(/connect-src https:\/\/api\.example\.com https:\/\/x\.y\.z/);
  });

  it("includes CDN URLs in script-src and style-src", () => {
    const csp = buildCsp({ network: [], cdns: ["chartjs@4.5"] });
    expect(csp).toMatch(/script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net/);
    expect(csp).toMatch(/style-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net/);
  });

  it("frame-src is always 'none'", () => {
    const csp = buildCsp({ network: ["x.com"], cdns: [] });
    expect(csp).toMatch(/frame-src 'none'/);
  });

  it("rejects unknown CDN keys", () => {
    expect(() => buildCsp({ network: [], cdns: ["bogus"] })).toThrow();
  });
});
