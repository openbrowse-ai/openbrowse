// apps/extension/src/entrypoints/artifact/build-iframe-doc.ts
import { buildCsp } from "@/lib/artifacts/csp";
import { BRIDGE_SHIM_SOURCE } from "./bridge-shim";
import type { ArtifactManifest } from "@/lib/artifacts/manifest";

const META_TAG_RE = /<meta[^>]+name=["']openbrowse:artifact["'][^>]*>/gi;

/**
 * Inject CSP <meta> and the bridge shim <script> into the artifact HTML.
 * Strips the manifest meta (host-only metadata; it must not survive into
 * the runtime iframe).
 */
export function buildIframeDoc(html: string, manifest: ArtifactManifest): string {
  const csp = buildCsp({
    network: manifest.network ?? [],
    cdns: manifest.cdns ?? [],
  });
  const cleaned = html.replace(META_TAG_RE, "");
  const cspMeta  = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  const shimTag  = `<script>${BRIDGE_SHIM_SOURCE}</script>`;
  if (/<head[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/(<head[^>]*>)/i, `$1${cspMeta}${shimTag}`);
  }
  // No <head>: wrap.
  return `<!doctype html><html><head>${cspMeta}${shimTag}</head><body>${cleaned}</body></html>`;
}
