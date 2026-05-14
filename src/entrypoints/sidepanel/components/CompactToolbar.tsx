import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HOME_PAGE_URL } from "@/lib/constants";
import { Eraser, Maximize2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

interface CompactToolbarProps {
  onClean: () => void;
  onTidy: () => void;
  isTidying: boolean;
}

export function CompactToolbar({
  onClean,
  onTidy,
  isTidying,
}: CompactToolbarProps) {
  const [tidyProgress, setTidyProgress] = useState("");

  useEffect(() => {
    function listener(changes: { [key: string]: chrome.storage.StorageChange }) {
      const progress = changes._tidyProgress?.newValue as
        | { phase: number; current: number; total: number }
        | undefined;
      if (!progress) return;
      if (progress.phase === -1) {
        setTidyProgress("");
        return;
      }
      if (progress.phase === 0) {
        setTidyProgress("loading model...");
      } else if (progress.phase === 1) {
        setTidyProgress(`${progress.current}/${progress.total}`);
      } else if (progress.phase === 2) {
        setTidyProgress(progress.current === 0 ? "grouping..." : "");
      }
    }
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  function handleOpenCollectPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL(HOME_PAGE_URL) });
  }

  return (
    <div className="flex items-center justify-between px-2 py-1">
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClean}
            >
              <Eraser className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="text-xs">Clean</span>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onTidy}
              disabled={isTidying}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="text-xs">
              {isTidying
                ? tidyProgress
                  ? /^\d/.test(tidyProgress)
                    ? `Tidying ${tidyProgress}`
                    : tidyProgress
                  : "Tidying..."
                : "Tidy"}
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleOpenCollectPage}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="text-xs">Open full view</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
