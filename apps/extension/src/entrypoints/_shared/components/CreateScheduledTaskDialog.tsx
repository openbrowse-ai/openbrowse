// src/entrypoints/_shared/components/CreateScheduledTaskDialog.tsx
import { ModelPicker } from "@/components/chat/ModelPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfiguredModels } from "@/hooks/useConfiguredModels";
import { DEFAULT_SETTINGS } from "@/lib/constants";
import { taskDb } from "@/lib/schedule/task-db";
import type {
  Schedule,
  ScheduleKind,
  ScheduledTask,
} from "@/lib/schedule/types";
import { storage } from "@/lib/storage";
import type { Settings } from "@/lib/types";
import { agentModelGate } from "@/registry/agent-capability";
import { useEffect, useRef, useState } from "react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this task; otherwise creates a new one. */
  editing?: ScheduledTask | null;
  /** Prefill values (e.g. from a conversation's "Schedule" action). */
  prefill?: {
    name?: string;
    prompt?: string;
    agentModel?: string;
    sourceConversationId?: string;
  } | null;
  /** Available model strings ("<provider>:<model>") for the picker. */
  models: string[];
  onSaved?: () => void;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function CreateScheduledTaskDialog({
  open,
  onOpenChange,
  editing,
  prefill,
  models,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [onceAt, setOnceAt] = useState(""); // datetime-local string
  const [autoApprove, setAutoApprove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const providerModels = useConfiguredModels(settings);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void storage.getSettings().then(setSettings);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      setName(editing.name);
      setDescription(editing.description);
      setPrompt(editing.prompt);
      setAgentModel(editing.agentModel);
      setKind(editing.schedule.kind);
      if ("hour" in editing.schedule) setHour(editing.schedule.hour);
      if ("minute" in editing.schedule) setMinute(editing.schedule.minute);
      if (editing.schedule.kind === "weekly")
        setWeekday(editing.schedule.weekday);
      if (editing.schedule.kind === "once")
        setOnceAt(toLocalInput(editing.schedule.at));
      setAutoApprove(editing.autoApprove ?? false);
    } else {
      setName(prefill?.name ?? "");
      setDescription("");
      setPrompt(prefill?.prompt ?? "");
      setAgentModel(prefill?.agentModel ?? models[0] ?? "");
      setKind("daily");
      setHour(9);
      setMinute(0);
      setWeekday(1);
      setOnceAt("");
      setAutoApprove(false);
    }
  }, [open, editing, prefill, models]);

  function buildSchedule(): Schedule {
    switch (kind) {
      case "manual":
        return { kind: "manual" };
      case "hourly":
        return { kind: "hourly", minute };
      case "daily":
        return { kind: "daily", hour, minute };
      case "weekdays":
        return { kind: "weekdays", hour, minute };
      case "weekly":
        return { kind: "weekly", weekday, hour, minute };
      case "once": {
        // Require an explicit future datetime — never fall back to Date.now(),
        // which would fire the run immediately on save.
        if (!onceAt) {
          throw new Error("Pick a date and time for the one-time run.");
        }
        const at = new Date(onceAt).getTime();
        if (Number.isNaN(at)) {
          throw new Error("That date and time isn't valid.");
        }
        if (at <= Date.now()) {
          throw new Error("Pick a date and time in the future.");
        }
        return { kind: "once", at };
      }
    }
  }

  async function handleSave() {
    if (!name.trim() || !prompt.trim() || !agentModel) return;
    setError(null);
    let schedule: Schedule;
    try {
      schedule = buildSchedule();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await taskDb.update(editing.id, {
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          agentModel,
          schedule,
          autoApprove,
        });
      } else {
        await taskDb.create({
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          agentModel,
          schedule,
          enabled: true,
          needsBrowser: true,
          autoApprove,
          sourceConversationId: prefill?.sourceConversationId,
        });
      }
      onSaved?.();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg max-h-[85vh] overflow-y-auto"
        onKeyDown={(e) => {
          if (e.metaKey && e.key === "Enter" && !saving) {
            e.preventDefault();
            void handleSave();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit scheduled task" : "Create scheduled task"}
          </DialogTitle>
        </DialogHeader>

        <div ref={formRef} className="flex flex-col gap-3">
          <label className="text-sm font-medium">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="daily-briefing"
          />

          <label className="text-sm font-medium">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this task does"
          />

          <label className="text-sm font-medium">Prompt</label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Instructions for the agent…"
          />

          <label className="text-sm font-medium">Model</label>
          <ModelPicker
            trigger="settings"
            providerModels={providerModels}
            value={agentModel || undefined}
            onValueChange={setAgentModel}
            modelGate={agentModelGate}
            placeholder="Select a model"
            portalContainer={formRef}
          />

          <label className="text-sm font-medium">Frequency</label>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as ScheduleKind)}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="hourly">Hourly</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekdays">Weekdays</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="once">Once</SelectItem>
              </SelectContent>
            </Select>

            {(kind === "daily" || kind === "weekdays" || kind === "weekly") && (
              <input
                type="time"
                className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  setHour(h);
                  setMinute(m);
                }}
              />
            )}

            {kind === "hourly" && (
              <input
                type="number"
                min={0}
                max={59}
                className="h-9 w-20 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={minute}
                onChange={(e) => setMinute(Number(e.target.value))}
              />
            )}

            {kind === "weekly" && (
              <Select
                value={String(weekday)}
                onValueChange={(v) => setWeekday(Number(v))}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {kind === "once" && (
              <input
                type="datetime-local"
                className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={onceAt}
                onChange={(e) => setOnceAt(e.target.value)}
              />
            )}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <label className="text-sm font-medium">
                Auto-approve tool actions
              </label>
              <p className="text-xs text-muted-foreground">
                Lets the scheduled run use tools that normally ask for
                confirmation (it runs with no one watching). Off by default.
              </p>
            </div>
            <Switch
              checked={autoApprove}
              onCheckedChange={setAutoApprove}
              className="mt-0.5 shrink-0"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Scheduled tasks only run while Chrome is open.
          </p>
        </div>

        <DialogFooter>
          {error && (
            <p className="mr-auto self-center text-xs text-destructive">
              {error}
            </p>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
            <Kbd className="ml-1.5">
              <span>⌘</span>
              <span>↵</span>
            </Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInput(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
