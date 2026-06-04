// src/lib/schedule/format.ts
import type { Schedule } from "./types";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "manual":
      return "Manual";
    case "hourly":
      return `Hourly at :${String(schedule.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${hhmm(schedule.hour, schedule.minute)}`;
    case "weekdays":
      return `Weekdays at ${hhmm(schedule.hour, schedule.minute)}`;
    case "weekly":
      return `Weekly on ${WEEKDAYS[schedule.weekday]} at ${hhmm(schedule.hour, schedule.minute)}`;
    case "once":
      return `Once on ${new Date(schedule.at).toLocaleString()}`;
  }
}

/**
 * Human-readable relative time for a future timestamp, e.g. "in 3 hours",
 * "in 5 minutes", "in 2 days". Returns "soon" for anything under a minute
 * away or already in the past (we never render a negative/"ago" value for a
 * next-run time).
 */
export function formatRelativeTime(epoch: number, now: number = Date.now()): string {
  const diffMs = epoch - now;
  if (diffMs < 60_000) return "soon";

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 24) return rtf.format(hours, "hour");
  const days = Math.round(diffMs / 86_400_000);
  return rtf.format(days, "day");
}
