import { DownloadCloud } from "lucide-react";
import { registerToolPreview } from "./registry";

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

registerToolPreview("install_skill", (args) => {
  const source = readString(args.source);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <DownloadCloud className="w-4 h-4 text-primary" />
        <span className="font-medium text-foreground">Install Skill</span>
      </div>

      {source && (
        <div className="bg-muted rounded px-3 py-2 text-sm text-foreground break-all">
          {source}
        </div>
      )}

      <div className="text-xs text-amber-500 mt-1">
        This will fetch files from the source and save them to the extension's local storage.
      </div>
    </div>
  );
});
