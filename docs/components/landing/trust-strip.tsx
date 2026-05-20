import Link from "next/link";
import { ArrowRight, Box, Code2, ShieldAlert, Star, WifiOff } from "lucide-react";

export function TrustStrip() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-12 border-y">
      <div className="flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-8 gap-y-4 text-sm font-medium text-muted-foreground">
          <div className="flex items-center gap-2">
            <Code2 className="size-4" />
            <span>Open Source</span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4" />
            <span>MIT Licensed</span>
          </div>
          <div className="flex items-center gap-2">
            <WifiOff className="size-4" />
            <span>Works Offline</span>
          </div>
          <div className="flex items-center gap-2">
            <Box className="size-4" />
            <span>No Telemetry</span>
          </div>
          <div className="flex items-center gap-2">
            <Star className="size-4" />
            <span>GitHub Stars</span>
          </div>
        </div>
        
        <Link 
          href="/docs/comparison"
          className="inline-flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors shrink-0"
        >
          Compare to Claude, Gemini & Comet
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}
