import React from "react";
import { PenTool } from "lucide-react";
import { registerToolPreview } from "./registry";

registerToolPreview("create_skill", ({ args }) => {
  const name = args?.name as string | undefined;
  const desc = args?.description as string | undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <PenTool className="w-4 h-4 text-primary" />
        <span className="font-medium text-foreground">Create Skill</span>
      </div>
      
      {name && (
        <div className="bg-muted rounded px-3 py-2 text-sm text-foreground">
          <strong>{name}</strong>
          {desc && <div className="text-muted-foreground mt-1 text-xs">{desc}</div>}
        </div>
      )}
      
      <div className="text-xs text-amber-500 mt-1">
        This will save the new skill to your local browser storage.
      </div>
    </div>
  );
});
