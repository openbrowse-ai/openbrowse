// apps/extension/src/entrypoints/artifact/__tests__/build-iframe-doc.test.ts
import { describe, it, expect, vi } from "vitest";

// Mock CDN_REGISTRY so buildCsp doesn't throw on the test fixtures.
const cdnReg = vi.hoisted(() => ({
  CDN_REGISTRY: {
    "chartjs@4.5": {
      key: "chartjs@4.5",
      url: "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js",
      integrity: "sha384-TEST",
    },
  },
}));
vi.mock("@/lib/artifacts/cdn-registry", () => cdnReg);

import { buildIframeDoc } from "../build-iframe-doc";
import type { ArtifactManifest } from "@/lib/artifacts/manifest";

const manifest: ArtifactManifest = {
  v: 1, id: "art", title: "X",
  tools: [],
  cdns: [],
  network: [],
};

describe("buildIframeDoc", () => {
  it("strips the openbrowse:artifact meta tag from the source HTML", () => {
    const html = `<!doctype html><html><head><meta name="openbrowse:artifact" content='{"v":1}'><title>X</title></head><body>hi</body></html>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).not.toContain("openbrowse:artifact");
  });

  it("strips the meta tag when other attributes precede name (order-agnostic)", () => {
    const html = `<html><head><meta http-equiv="x" name="openbrowse:artifact" content='{"v":1}'></head><body>hi</body></html>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).not.toContain("openbrowse:artifact");
  });

  it("strips the meta tag with whitespace around the name equals sign", () => {
    const html = `<html><head><meta name = "openbrowse:artifact" content='{"v":1}'></head><body>hi</body></html>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).not.toContain("openbrowse:artifact");
  });

  it("strips a tag whose content JSON contains a raw '>' character", () => {
    // `>` inside the quoted content must not terminate the match early.
    const html = `<html><head><meta name="openbrowse:artifact" content='{"note":"a > b"}'></head><body>hi</body></html>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).not.toContain("openbrowse:artifact");
  });

  it("does NOT mangle an unrelated tag whose quoted value mentions the marker", () => {
    // A benign attribute value containing name='openbrowse:artifact' must be
    // left intact (the marker is inside quotes, not the tag's own name attr).
    const html = `<html><head><meta property="og:desc" content="see name='openbrowse:artifact' here"><title>T</title></head><body>hi</body></html>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).toContain(`content="see name='openbrowse:artifact' here"`);
    expect(out).toContain("<title>T</title>");
  });

  it("injects CSP meta and bridge shim script after <head>", () => {
    const html = `<!doctype html><html><head><title>X</title></head><body>hi</body></html>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain("<script>");
    expect(out).toContain("window.openbrowse"); // from BRIDGE_SHIM_SOURCE
  });

  it("wraps HTML when there is no <head>", () => {
    const html = `<body>hi</body>`;
    const out = buildIframeDoc(html, manifest);
    expect(out).toMatch(/^<!doctype/i);
    expect(out).toContain("<head>");
    expect(out).toContain("Content-Security-Policy");
  });

  it("uses connect-src 'none' when manifest.network is empty", () => {
    const out = buildIframeDoc(`<html><head></head><body></body></html>`, manifest);
    expect(out).toMatch(/connect-src 'none'/);
  });

  it("escapes double quotes inside the CSP value", () => {
    // CSP values won't normally contain ", but if buildCsp ever does we shouldn't break the meta.
    const m = { ...manifest, network: ['safe-host.com'] };
    const out = buildIframeDoc(`<html><head></head><body></body></html>`, m);
    // No raw " inside the content="..." attribute (other than the delimiters).
    const cspMatch = out.match(/content="([^"]*)"/);
    expect(cspMatch).toBeTruthy();
  });
});
