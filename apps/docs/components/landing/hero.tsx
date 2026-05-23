import Link from "next/link";
import { AgentScene } from "./scenes/agent/AgentScene";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-24 pb-16 md:pt-32">
      <div className="flex flex-col items-center text-center mb-16">
        <h1 className="font-mono font-bold tracking-tight text-3xl md:text-5xl max-w-5xl">
          The open source browser agent.
        </h1>
        <p className="mt-6 text-base md:text-lg text-muted-foreground leading-relaxed max-w-3xl">
          OpenBrowse reads pages, takes actions, and organizes your tabs.
          Use any model — cloud, self-hosted, or fully on-device.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link
            href="/docs/overview#install"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-foreground px-8 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            <ChromeIcon className="h-4 w-4" />
            Install
          </Link>
          <a
            href="https://github.com/openbrowse-ai/openbrowse"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center rounded-md border px-8 text-sm font-medium transition-colors hover:bg-muted"
          >
            GitHub
          </a>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Chrome Web Store listing coming soon — install manually for now.
        </p>
      </div>

      <AgentScene />
    </section>
  );
}

function ChromeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8 0-1.85.63-3.55 1.69-4.9L9.5 12l-1.64 4.5A7.96 7.96 0 0012 20zm6.31-3.1L14.5 12l1.64-4.5A7.96 7.96 0 0012 4c1.85 0 3.55.63 4.9 1.69L12 12l6.31 4.9zM12 15a3 3 0 100-6 3 3 0 000 6z" />
    </svg>
  );
}
