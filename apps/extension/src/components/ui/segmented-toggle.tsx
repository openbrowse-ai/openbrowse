import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

export interface SegmentedToggleProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  disabledValues?: T[];
}

/**
 * A compact two-or-more segment pill toggle with icon buttons. Used by the
 * file viewer (Preview/Source, Tree/Raw) and the artifact header
 * (Rendered/Source) so the control looks consistent across the app.
 */
export function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
  disabledValues,
}: SegmentedToggleProps<T>) {
  return (
    <div className="inline-flex items-center rounded-md bg-muted p-0.5">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === value;
        const disabled = disabledValues?.includes(opt.value) ?? false;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(opt.value)}
                className={cn(
                  "h-6 px-2 rounded-sm flex items-center gap-1 text-[11px] font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  disabled && "opacity-50 cursor-not-allowed",
                )}
                aria-label={opt.label}
                aria-pressed={active}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{opt.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
