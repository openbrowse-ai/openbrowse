// src/lib/schedule/next-run.ts
import type { Schedule } from "./types";

/**
 * Compute the next fire time (absolute epoch ms) for a schedule, strictly
 * after `now`. All recurring kinds are evaluated in the host's LOCAL
 * timezone. Returns null for `manual` and for a `once` already in the past.
 */
export function computeNextRun(schedule: Schedule, now: number): number | null {
  switch (schedule.kind) {
    case "manual":
      return null;
    case "once":
      return schedule.at > now ? schedule.at : null;
    case "hourly": {
      const d = new Date(now);
      d.setSeconds(0, 0);
      d.setMinutes(schedule.minute);
      if (d.getTime() <= now) d.setTime(d.getTime() + 60 * 60 * 1000);
      return d.getTime();
    }
    case "daily": {
      return nextDailyMatch(now, schedule.hour, schedule.minute, () => true);
    }
    case "weekdays": {
      return nextDailyMatch(
        now,
        schedule.hour,
        schedule.minute,
        (day) => day >= 1 && day <= 5,
      );
    }
    case "weekly": {
      return nextDailyMatch(
        now,
        schedule.hour,
        schedule.minute,
        (day) => day === schedule.weekday,
      );
    }
  }
}

/**
 * Find the next local-time instant at hour:minute on a day matching
 * `dayAllowed(weekday)`, strictly after `now`. Scans up to 8 days ahead
 * (covers weekly + weekdays).
 */
function nextDailyMatch(
  now: number,
  hour: number,
  minute: number,
  dayAllowed: (weekday: number) => boolean,
): number {
  const base = new Date(now);
  base.setSeconds(0, 0);
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(base);
    d.setDate(base.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > now && dayAllowed(d.getDay())) {
      return d.getTime();
    }
  }
  // Unreachable for valid inputs (a matching day always occurs within 8 days).
  throw new Error("computeNextRun: no match within 8 days");
}
