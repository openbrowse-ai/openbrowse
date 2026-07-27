import {
    AppWindowMacIcon,
    BrushCleaningIcon,
    Clock,
    Maximize2,
    MessageCircle,
    Palette,
    Settings,
    Sparkles,
} from "lucide-react";
import type { ComponentType } from "react";

export interface ActionItem {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  type: "action" | "space";
}

const ACTIONS: ActionItem[] = [
  { id: "tidy", label: "Tidy tabs", icon: Sparkles, type: "action" },
  { id: "clean", label: "Clean (close tabs)", icon: BrushCleaningIcon, type: "action" },
  { id: "new-chat", label: "New chat", icon: MessageCircle, type: "action" },
  { id: "history", label: "History", icon: Clock, type: "action" },
  { id: "new-space", label: "New space", icon: AppWindowMacIcon, type: "action" },
  { id: "configure-space", label: "Configure space", icon: Palette, type: "action" },
  { id: "full-view", label: "Open full view", icon: Maximize2, type: "action" },
  { id: "settings", label: "Settings", icon: Settings, type: "action" },
];

function matchesQuery(label: string, query: string): boolean {
  if (!query) return true;
  return label.toLowerCase().includes(query.toLowerCase());
}

/**
 * Filter the overlay's command actions by a query. Actions feed the palette's
 * Commands group; spaces are matched separately via `buildSpaceMatches`.
 */
export function useFilteredActions(actionQuery: string): ActionItem[] {
  return ACTIONS.filter((a) => matchesQuery(a.label, actionQuery));
}
