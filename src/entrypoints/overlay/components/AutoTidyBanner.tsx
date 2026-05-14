import type { AutoTidyNotification } from "@/lib/types";

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface AutoTidyBannerProps {
  notification: AutoTidyNotification;
  onDismiss: () => void;
}

export function AutoTidyBanner({ notification, onDismiss }: AutoTidyBannerProps) {
  const parts: string[] = [];
  if (notification.archivedCount > 0) {
    parts.push(`archived ${notification.archivedCount} tab${notification.archivedCount === 1 ? "" : "s"}`);
  }
  if (notification.sectionCount > 0) {
    parts.push(`organized ${notification.tabCount} tab${notification.tabCount === 1 ? "" : "s"} into ${notification.sectionCount} section${notification.sectionCount === 1 ? "" : "s"}`);
  }

  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 mx-2 mt-2 rounded-lg bg-muted/50 text-xs text-muted-foreground border border-border/50">
      <span className="flex-1">
        Tabs tidied {formatTimeAgo(notification.timestamp)} — {parts.join(", ")}
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors"
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}
