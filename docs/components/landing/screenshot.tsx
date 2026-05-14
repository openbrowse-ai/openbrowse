import { PlayCircle } from "lucide-react";

/**
 * PLACEHOLDER — Demo Video
 *
 * Replace the placeholder block below with a short looping screen recording
 * (ideally <15s, muted, autoplay) of the agent doing one end-to-end task.
 *
 * Suggested content for the recording:
 *   - Open a new tab, invoke the agent via ⌥I (or the command palette via ⌥K)
 *   - Type a natural-language instruction like:
 *       "summarize this page" or "find cheapest mechanical keyboard on amazon"
 *   - Show the agent navigating / clicking / extracting and returning a result
 *   - End on the result panel with the extracted answer
 *
 * Asset path convention: /public/demo.mp4 + /public/demo-poster.jpg
 * Dimensions: 1920x1080, H.264, <3MB if possible.
 */
export function Screenshot() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-16">
      <div className="relative aspect-video overflow-hidden rounded-sm border bg-muted/30">
        {/* Replace this block with <video autoPlay muted loop playsInline poster="/demo-poster.jpg" src="/demo.mp4" /> */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <PlayCircle className="h-12 w-12" strokeWidth={1.25} />
          <p className="text-sm font-medium">Demo video placeholder</p>
          <p className="max-w-md px-6 text-center text-xs">
            Short loop (&lt;15s) of the agent performing one real task — e.g.
            &quot;summarize this page&quot; or &quot;find the cheapest mechanical
            keyboard&quot; — showing navigation, clicks, and the extracted result.
          </p>
        </div>
      </div>
    </section>
  );
}
