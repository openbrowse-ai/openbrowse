import { Boxes, ExternalLink, X } from "lucide-react";
import { Host } from "@/entrypoints/artifact/Host";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ArtifactViewerPanelProps {
  artifactId: string;
  /** Title shown in the header. Falls back to the id if omitted. */
  title?: string;
  onClose: () => void;
  className?: string;
}

/**
 * In-panel viewer for a saved artifact, mirroring FileViewerPanel. Renders the
 * artifact runtime via <Host mode="embed">, which owns the single header bar
 * (rendered/source toggle + console). This panel injects the title and the
 * open-tab/close actions into that same bar via Host's embed header slots, so
 * there's one unified header rather than two stacked ones.
 *
 * Controlled like FileViewerPanel: no internal open state — the parent mounts/
 * unmounts it and supplies `onClose`.
 */
export function ArtifactViewerPanel({
  artifactId,
  title,
  onClose,
  className,
}: ArtifactViewerPanelProps) {
  const openTab = () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL(
        `artifact.html?id=${encodeURIComponent(artifactId)}`,
      ),
    });
  };

  const headerLeft = (
    <>
      <Boxes className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className="text-sm font-medium truncate text-foreground/90"
        title={title ?? artifactId}
      >
        {title ?? artifactId}
      </span>
      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider bg-muted text-muted-foreground">
        ARTIFACT
      </span>
    </>
  );

  const headerRight = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openTab}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            aria-label="Open in a separate tab"
          >
            <ExternalLink className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Open as tab</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            aria-label="Close artifact"
          >
            <X className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Close</TooltipContent>
      </Tooltip>
    </>
  );

  return (
    <div className={cn("flex flex-col h-full min-h-0 bg-background", className)}>
      <Host
        key={artifactId}
        artifactId={artifactId}
        mode="embed"
        embedHeaderLeft={headerLeft}
        embedHeaderRight={headerRight}
      />
    </div>
  );
}
