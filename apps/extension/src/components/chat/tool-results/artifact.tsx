import { Button } from "@/components/ui/button";
import { Boxes, ExternalLink } from "lucide-react";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Compact "created artifact" record shown in the chat transcript. It does NOT
 * render the artifact inline — opening happens in the workspace rail's
 * ArtifactViewer or in a separate tab. (The chat lives in the side panel, which
 * has no rail, so here we offer "Open as Tab".)
 */
export function ArtifactResult({ args, result }: Props) {
  const obj = (result ?? {}) as { artifactId?: string; openUrl?: string };
  const argTitle =
    typeof args?.title === "string" ? args.title : obj.artifactId ?? "Artifact";
  // The agent supplies an emoji as part of create_artifact's args; show it as
  // the leading glyph so the transcript record matches the standalone tab's
  // favicon. Older agent calls (or other tools that reuse this renderer) may
  // omit it, in which case we fall back to the generic Boxes icon.
  const icon = typeof args?.icon === "string" && args.icon.length > 0 ? args.icon : null;

  if (!obj.artifactId || !obj.openUrl) return null;

  return (
    <div className="ml-3 mt-1 flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon ? (
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-base leading-none"
          >
            {icon}
          </span>
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Boxes className="size-3.5" />
          </span>
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{argTitle}</span>
          <span className="text-xs text-muted-foreground">Artifact created</span>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => chrome.tabs.create({ url: obj.openUrl })}
        className="h-7 shrink-0 gap-1 text-xs"
      >
        <ExternalLink className="size-3.5" /> Open as Tab
      </Button>
    </div>
  );
}
