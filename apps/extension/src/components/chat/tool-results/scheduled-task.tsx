import { Clock, CheckCircle2, XCircle, List } from "lucide-react";

function formatRunTime(epoch: number | null | undefined): string {
  if (epoch == null) return "—";
  return new Date(epoch).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Shell({
  icon,
  header,
  children,
}: {
  icon: React.ReactNode;
  header: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        {icon}
        <span className="truncate">{header}</span>
      </div>
      {children && (
        <div className="px-3 py-2 bg-background/50">{children}</div>
      )}
    </div>
  );
}

interface RProps {
  args: Record<string, unknown>;
  result: unknown;
}

export function CreateScheduledTaskResult({ args, result }: RProps) {
  const r = result as
    | { created: true; id: string; nextRunAt: number | null }
    | { created: false; reason: string }
    | undefined;
  const name = typeof args.name === "string" ? args.name : "task";

  if (r && r.created === false) {
    return (
      <Shell
        icon={<XCircle className="size-3 shrink-0 text-destructive" />}
        header={`Couldn't schedule “${name}”`}
      >
        <span className="text-muted-foreground">{r.reason}</span>
      </Shell>
    );
  }

  return (
    <Shell
      icon={<CheckCircle2 className="size-3 shrink-0 text-emerald-500" />}
      header={`Scheduled “${name}”`}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Clock className="size-3 shrink-0" />
        <span>Next run: {formatRunTime(r?.created ? r.nextRunAt : null)}</span>
      </div>
    </Shell>
  );
}

export function UpdateScheduledTaskResult({ args, result }: RProps) {
  const r = result as
    | { updated: true }
    | { updated: false; reason: string }
    | undefined;
  const name = typeof args.name === "string" ? args.name : null;
  const enabled =
    typeof args.enabled === "boolean" ? args.enabled : undefined;

  if (r && r.updated === false) {
    return (
      <Shell
        icon={<XCircle className="size-3 shrink-0 text-destructive" />}
        header="Couldn't update scheduled task"
      >
        <span className="text-muted-foreground">{r.reason}</span>
      </Shell>
    );
  }

  let header = name ? `Updated “${name}”` : "Updated scheduled task";
  if (enabled === false) header = name ? `Paused “${name}”` : "Paused scheduled task";
  if (enabled === true) header = name ? `Resumed “${name}”` : "Resumed scheduled task";

  return (
    <Shell
      icon={<CheckCircle2 className="size-3 shrink-0 text-emerald-500" />}
      header={header}
    />
  );
}

interface TaskSummary {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunStatus: string | null;
}

export function ListScheduledTasksResult({ result }: RProps) {
  const r = result as { tasks?: TaskSummary[] } | undefined;
  const tasks = r?.tasks ?? [];

  return (
    <Shell
      icon={<List className="size-3 shrink-0" />}
      header={
        tasks.length === 0
          ? "No scheduled tasks"
          : `${tasks.length} scheduled ${tasks.length === 1 ? "task" : "tasks"}`
      }
    >
      {tasks.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">{t.name}</span>
                {!t.enabled && (
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                    Paused
                  </span>
                )}
              </div>
              <span className="text-muted-foreground">
                {t.schedule}
                {t.enabled && ` · next ${formatRunTime(t.nextRunAt)}`}
                {t.lastRunStatus && ` · last: ${t.lastRunStatus}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
