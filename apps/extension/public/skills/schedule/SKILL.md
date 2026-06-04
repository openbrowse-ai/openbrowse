---
name: schedule
description: Create, list, and manage scheduled tasks that run automatically on a recurring schedule or as a one-time future event. Use whenever the user wants to automate something repeatedly ("every morning", "weekdays at 8:30") or set a one-off future run ("in 20 minutes", "tomorrow at 3pm").
---

# Schedule Skill

Set up and manage **scheduled tasks**: a saved prompt that OpenBrowse runs
automatically at a time you choose, in a dedicated browser window, while
Chrome is open. Each run lands as a conversation in your history and you get
a notification when it finishes.

You have three tools:

- `create_scheduled_task` — set up a task that runs automatically, either on a
  recurring schedule (`hourly`, `daily`, `weekdays`, `weekly`) or as a
  one-time future event.
- `list_scheduled_tasks` — see all existing tasks, their schedules, whether
  they're enabled, and their last run status.
- `update_scheduled_task` — change a task's prompt or schedule, rename it, or
  pause/resume it (set `enabled`).

## Creating a task

1. **Understand what to automate.** Get a clear, self-contained instruction
   the agent can run with no human present — it cannot ask follow-up
   questions mid-run. Restate the task as the `prompt`.
2. **Determine the schedule.** Map the user's words to a schedule:
   - "every hour" → `{ kind: "hourly", minute: 0 }`
   - "every day at 9am" → `{ kind: "daily", hour: 9, minute: 0 }`
   - "weekdays at 8:30" → `{ kind: "weekdays", hour: 8, minute: 30 }`
   - "every Monday at 9am" → `{ kind: "weekly", weekday: 1, hour: 9, minute: 0 }`
     (weekday: 0=Sunday … 6=Saturday)
   - "in 20 minutes" → `{ kind: "once", inMinutes: 20 }`
   - "tomorrow at 3pm" → `{ kind: "once", at: "<ISO 8601 local time>" }`
   All times are the user's local time. For relative one-time events prefer
   `inMinutes` (you don't need to know the current time). For absolute ones
   pass an ISO 8601 `at`.
3. **Pick a short `name`** (e.g. `daily-briefing`) and a one-line
   `description`. Omit `agentModel` to use the current model.
4. **Confirm with the user** what you're about to schedule (prompt + when),
   then call `create_scheduled_task`.
5. **Report** the created task and when it will first run.

## Listing and managing

- To show what's scheduled, call `list_scheduled_tasks` and summarize each
  task's name, schedule, enabled state, and next run.
- To change or pause a task, call `list_scheduled_tasks` first to get its
  `id`, then `update_scheduled_task`:
  - Pause: `{ id, enabled: false }` · Resume: `{ id, enabled: true }`
  - Reschedule: `{ id, schedule: { … } }`
  - Edit the instruction: `{ id, prompt: "…" }`

## Good to know

- Scheduled tasks only run while Chrome is open. If Chrome is closed when a
  task is due, that run is skipped and the next occurrence is scheduled.
- Each run opens its own browser window and closes it when done.
- A running scheduled task cannot itself create or modify scheduled tasks.
- The user can also create and manage tasks visually from the **Scheduled**
  page in the sidebar.
