import { ChevronDown, Hand, ListChecks, Play } from "lucide-react";
import { useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ConversationMode } from "@/lib/types";

interface ModeSwitchProps {
  mode: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  disabled?: boolean;
  /**
   * True when the conversation has an approved plan. In Plan mode the
   * trigger renders a small emerald dot to distinguish "Plan, plan
   * approved — agent is operating within bounds" from "Plan, no plan
   * yet — agent will be prompted to call proposePlan first". Without
   * this signal the trigger label is the same in both states, which
   * obscures the most important plan-mode UI fact.
   */
  hasPlan?: boolean;
}

interface ModeOption {
  value: ConversationMode;
  label: string;
  description: string;
  icon: typeof Hand;
}

export const MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  {
    value: "ask",
    label: "Ask before acting",
    description: "Pause and approve each gated action.",
    icon: Hand,
  },
  {
    value: "plan",
    label: "Plan before acting",
    description: "Approve a plan once; agent executes within those bounds.",
    icon: ListChecks,
  },
  {
    value: "act",
    label: "Act without asking",
    description: "No approvals. Use only on trusted, repeated workflows.",
    icon: Play,
  },
];

export function shortLabel(mode: ConversationMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    case "act":
      return "Act";
  }
}

/**
 * Returns the mode that follows `current` in the {@link MODE_OPTIONS}
 * cycle (ask → plan → act → ask). The cycle order is load-bearing —
 * see the test in `mode-switch.test.ts`. Used by the Cmd/Ctrl+. hotkey
 * inside {@link ModeSwitch}.
 */
export function nextMode(current: ConversationMode): ConversationMode {
  const idx = MODE_OPTIONS.findIndex((o) => o.value === current);
  return MODE_OPTIONS[(idx + 1) % MODE_OPTIONS.length].value;
}

export function ModeSwitch({ mode, onChange, disabled, hasPlan }: ModeSwitchProps) {
  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0];
  const Icon = current.icon;
  const showPlanApprovedDot = mode === "plan" && hasPlan === true;

  // Cmd/Ctrl+. silently rotates to the next mode (ask → plan → act →
  // ask). The trigger label re-renders to reflect the new selection;
  // the dropdown does NOT auto-open. Uses a capture-phase document
  // listener (matching ChatInput's alt+/ handler) so Tiptap's
  // contenteditable doesn't swallow the keystroke before we see it —
  // `react-hotkeys-hook` listens during the bubble phase and gets
  // pre-empted by ProseMirror inside the composer. Gated on `disabled`
  // so the shortcut mirrors the click handler.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "." || e.code === "Period")
      ) {
        e.preventDefault();
        if (disabled) return;
        onChange(nextMode(mode));
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [mode, onChange, disabled]);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
            >
              <Icon className="size-3.5" />
              <span>{shortLabel(current.value)}</span>
              {showPlanApprovedDot && (
                <span
                  className="size-1.5 rounded-full shrink-0 bg-emerald-500"
                  aria-label="Plan approved"
                />
              )}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex items-center gap-1.5">
          Cycle modes <Kbd>⌘.</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="center" className="min-w-72 p-1">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(v) => onChange(v as ConversationMode)}
        >
          {MODE_OPTIONS.map((opt) => {
            const ActiveIcon = opt.icon;
            return (
              <DropdownMenuRadioItem
                key={opt.value}
                value={opt.value}
                className="items-start gap-2 py-2 pl-2"
              >
                <ActiveIcon className="size-3.5 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium leading-none mb-1">
                    {opt.label}
                  </div>
                  <div className="text-xs text-muted-foreground leading-snug">
                    {opt.description}
                  </div>
                </div>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
