import type { ArtifactManifest } from "@/lib/artifacts/manifest";
import { CDN_REGISTRY } from "@/lib/artifacts/cdn-registry";
import { Check, AlertTriangle } from "lucide-react";

/**
 * Humanise a tool name for display.
 * mcp.linear.search_issues -> "Linear: search issues"
 */
export function humaniseToolName(name: string): string {
  if (name.startsWith("mcp.")) {
    const [, server, ...rest] = name.split(".");
    return `${capitalise(server)}: ${rest.join(" ").replace(/_/g, " ")}`;
  }
  if (name.startsWith("browser.")) return `browser: ${name.slice("browser.".length).replace(/_/g, " ")}`;
  if (name.startsWith("system.")) return `system: ${name.slice("system.".length).replace(/_/g, " ")}`;
  return name;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Passive, read-only summary of what an artifact is allowed to do. Rendered in
 * the artifact header popover and inside the write-approval dialog. Carries no
 * actions of its own — approval happens lazily at first write call.
 */
export function ArtifactPermissions({ manifest }: { manifest: ArtifactManifest }) {
  const reads = manifest.tools.filter((t) => t.mode === "read");
  const writes = manifest.tools.filter((t) => t.mode === "write");
  const network = manifest.network ?? [];
  const cdns = (manifest.cdns ?? []).map((k) => CDN_REGISTRY[k]?.url ?? k);

  return (
    <div className="text-sm">
      <h3 className="text-xs font-medium uppercase text-muted-foreground mb-2">This artifact can</h3>
      <ul className="space-y-1">
        {reads.map((t) => (
          <li key={t.name} className="flex items-center gap-2">
            <Check className="h-4 w-4 shrink-0 text-green-600" /> Read {humaniseToolName(t.name)}
          </li>
        ))}
        {writes.map((t) => (
          <li key={t.name} className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> Write: {humaniseToolName(t.name)}
          </li>
        ))}
        {reads.length === 0 && writes.length === 0 && (
          <li className="text-muted-foreground">No tool access</li>
        )}
      </ul>

      {network.length > 0 && (
        <>
          <h3 className="text-xs font-medium uppercase text-muted-foreground mt-3 mb-2">Network access</h3>
          <ul className="space-y-1">
            {network.map((h) => (
              <li key={h} className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> {h}
              </li>
            ))}
          </ul>
        </>
      )}

      {cdns.length > 0 && (
        <>
          <h3 className="text-xs font-medium uppercase text-muted-foreground mt-3 mb-2">External libraries</h3>
          <ul className="text-xs text-muted-foreground space-y-1">
            {cdns.map((u) => (
              <li key={u} className="break-all">{u}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
