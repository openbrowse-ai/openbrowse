import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Inline help — renders an unfamiliar term (the `term` prop) as the
 * visible trigger with a dashed underline; hovering or focusing the
 * term reveals a tooltip containing `children` (the plain-English
 * explanation).
 *
 * Design rationale: separate `(?)` icons next to every jargon word
 * make the surface look like a developer interface. Underlining the
 * unfamiliar word itself is the long-standing dictionary convention
 * and keeps the prose flowing; users who already know the term never
 * notice the affordance.
 *
 * The Radix `Tooltip` primitive handles keyboard focus + screen
 * reader semantics. The trigger is a `<button type="button">` so the
 * default browser focus ring works; the dashed underline is applied
 * via Tailwind utilities so the visual treatment is consistent with
 * the rest of the settings page typography.
 *
 * Each `InlineHelp` instantiates its own `TooltipProvider` so callers
 * don't have to wrap parents in one. The `delayDuration` is small but
 * non-zero so a user dragging the cursor through a paragraph doesn't
 * trigger a flash of tooltips.
 */
export interface InlineHelpProps {
  /**
   * The visible phrase that triggers the tooltip — also used as the
   * tooltip's accessible name. Pass the phrase exactly as it should
   * appear in prose (e.g. `term="MCP clients"`).
   */
  term: string;
  /** Plain-English explanation rendered inside the tooltip. */
  children: React.ReactNode;
  /** Optional className appended to the trigger span. */
  className?: string;
}

export function InlineHelp({ term, children, className }: InlineHelpProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            // `cursor-help` is the canonical pointer for help affordances.
            // The dashed underline keeps the term reading naturally in
            // prose while still signalling that there's more to learn.
            className={`cursor-help underline decoration-dotted underline-offset-2 decoration-muted-foreground/60 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm ${className ?? ""}`}
          >
            {term}
          </button>
        </TooltipTrigger>
        <TooltipContent
          // Wider than the default tooltip so multi-sentence
          // explanations don't wrap into a tall ribbon.
          className="max-w-sm whitespace-normal text-left leading-relaxed"
          side="top"
          align="start"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
