import type { Space } from "@/lib/types";

interface SpaceHeaderProps {
  space: Space;
  tabCount: number;
  pinnedCount: number;
}

export function SpaceHeader({ space, tabCount, pinnedCount }: SpaceHeaderProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-4xl">{space.icon || "🌐"}</span>
      <h1 className="text-lg font-semibold text-foreground">{space.name}</h1>
      <p className="text-xs text-muted-foreground">
        {tabCount} tab{tabCount !== 1 ? "s" : ""}
        {pinnedCount > 0 && ` · ${pinnedCount} pinned`}
      </p>
    </div>
  );
}
