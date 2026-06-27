import { CDN_REGISTRY } from "./cdn-registry";

export interface CspInput {
  network: string[];
  cdns: string[];
}

export function buildCsp(input: CspInput): string {
  const cdnUrls: string[] = [];
  for (const c of input.cdns) {
    const e = CDN_REGISTRY[c];
    if (!e) throw new Error(`unknown cdn: ${c}`);
    cdnUrls.push(new URL(e.url).origin);
  }
  const cdnList = Array.from(new Set(cdnUrls));
  const connectSrc = input.network.length > 0
    ? input.network.map((h) => `https://${h}`).join(" ")
    : "'none'";
  // 'unsafe-inline' is acceptable here: artifacts run in a sandboxed iframe
  // with an opaque origin (sandbox="allow-scripts" without allow-same-origin),
  // so they cannot reach extension APIs, cookies, or same-origin storage.
  // CSP here is defense-in-depth on top of the sandbox.
  const scriptSrc = ["'unsafe-inline'", ...cdnList].join(" ");
  const styleSrc  = ["'unsafe-inline'", ...cdnList].join(" ");
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src data: blob:",
    "font-src data:",
    `connect-src ${connectSrc}`,
    "frame-src 'none'",
  ].join("; ");
}
