import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { useCallback } from "react";

export type SuggestionsProps = ComponentProps<"div">;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <div
    className={cn("flex flex-wrap items-center gap-2", className)}
    {...props}
  >
    {children}
  </div>
);

export type SuggestionProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(() => {
    onClick?.(suggestion);
  }, [onClick, suggestion]);

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 cursor-pointer rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-all hover:bg-accent",
        className,
      )}
      onClick={handleClick}
      type="button"
      {...props}
    >
      {children || suggestion}
    </button>
  );
};
