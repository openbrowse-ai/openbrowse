interface TabCardProps {
  title: string;
  url: string;
  favicon: string;
  onClick: () => void;
}

export function TabCard({ title, url, favicon, onClick }: TabCardProps) {
  const domain = (() => {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url;
    }
  })();

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent w-full max-w-[220px]"
    >
      {favicon ? (
        <img src={favicon} alt="" className="size-4 shrink-0 rounded-sm" />
      ) : (
        <div className="size-4 shrink-0 rounded-sm bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">
          {title}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {domain}
        </div>
      </div>
    </button>
  );
}
