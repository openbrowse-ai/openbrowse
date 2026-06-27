export interface CdnEntry {
  key: string;       // matches manifest.cdns entries (e.g. "chartjs@4.5")
  url: string;       // exact URL for <script src>
  integrity: string; // SRI hash, e.g. "sha384-…"
}

/**
 * Allowlist of CDN scripts an artifact may load.
 *
 * Each entry's `url` must point at an immutable, version-pinned file so the
 * `integrity` SRI hash stays valid. Any manifest referencing a key not in this
 * map is rejected by validateManifest. The host does NOT inject these script
 * tags — the artifact author writes their own `<script src>`; declaring the key
 * only adds the URL's ORIGIN to the iframe CSP so that tag is permitted.
 *
 * IMPORTANT: the CSP enforces the origin only, NOT the SRI hash. The `integrity`
 * field here is not enforced by the host at all — it is reference data the
 * author copies into a `<script integrity=...>` attribute, so that the BROWSER's
 * own Subresource Integrity check rejects a tampered/swapped file. An artifact
 * that loads a different path on the same allowlisted origin, or omits
 * `integrity`, still passes the CSP. Do not describe this as host-enforced
 * pinning (see authoring-artifacts/SKILL.md "Allowed CDNs").
 *
 * To add an entry, generate the SRI hash against the exact pinned URL:
 *   curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
 * then prefix the result with "sha384-".
 */
export const CDN_REGISTRY: Record<string, CdnEntry> = {
  "chartjs@4.5": {
    key: "chartjs@4.5",
    url: "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js",
    integrity: "sha384-XcdcwHqIPULERb2yDEM4R0XaQKU3YnDsrTmjACBZyfdVVqjh6xQ4/DCMd7XLcA6Y",
  },
  "gridjs@5.0.2": {
    key: "gridjs@5.0.2",
    url: "https://cdn.jsdelivr.net/npm/gridjs@5.0.2/dist/gridjs.umd.js",
    integrity: "sha384-/XXDzxe4FsGiAe50i/u9pY/Vy/uX654MHB1xoc1BJNnH1WXHhqHga9g3q5tF4gj7",
  },
  "mermaid@11.10": {
    key: "mermaid@11.10",
    url: "https://cdn.jsdelivr.net/npm/mermaid@11.10.0/dist/mermaid.min.js",
    integrity: "sha384-PY+AFiXLIHkR5jE4nk0JwPQQmmQlT4mJXFlgeT4jJeuARaBQBK+nSwwxzrPRAtUM",
  },
  // Key advertises "d3@7" but the URL is pinned to an exact patch so the SRI
  // hash can't break when a future 7.x is published.
  "d3@7": {
    key: "d3@7",
    url: "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
    integrity: "sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i",
  },
};

export function getCdn(key: string): CdnEntry | undefined {
  return CDN_REGISTRY[key];
}
