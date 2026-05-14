import { ImageIcon } from "lucide-react";

interface Feature {
  number: string;
  title: string;
  description: string;
  bullets?: string[];
  imageHint: string;
}

const features: Feature[] = [
  {
    number: "01",
    title: "Any model, cloud or local.",
    description:
      "Run fully in-browser with Chrome Built-in AI or WebLLM — no API key, no server. Or bring your own key for OpenAI, Anthropic, Google, and OpenAI-compatible providers (Groq, Together, etc.).",
    bullets: ["Chrome Built-in AI", "WebLLM", "OpenAI", "Anthropic", "Google", "+ compatible APIs"],
    imageHint: "Model provider picker in settings — show the full list with 'Local' badges.",
  },
  {
    number: "02",
    title: "Spaces with per-space themes.",
    description:
      "Organize windows by context — work, research, personal — and give each space its own color. Tabs, UI chrome, and the command palette all pick up the accent.",
    imageHint: "Side-by-side windows with two different accent colors (e.g. blue + amber).",
  },
  {
    number: "03",
    title: "Command palette (⌥K).",
    description:
      "A global overlay on every tab. Search any open tab, jump between spaces, kick off AI actions, or invoke the agent — without leaving the page you're on.",
    imageHint: "Command palette overlay on top of a real page, showing tab search + AI actions.",
  },
  {
    number: "04",
    title: "MCP connectors.",
    description:
      "Plug the agent into external services via the Model Context Protocol. GitHub, Linear, Slack, Notion — the agent can read and act on your tools, not just the web page.",
    imageHint:
      "Connector grid in settings — logos for GitHub, Linear, Slack, Notion, etc. with toggles.",
  },
  {
    number: "05",
    title: "AI Tidy.",
    description:
      "One command to group related tabs by topic, clean up cluttered titles, and archive the stale ones. The agent reads what's actually on the pages, not just the URL.",
    imageHint: "Before/after of tab list — messy titles on the left, clean grouped tabs on the right.",
  },
];

function ImagePlaceholder({ hint }: { hint: string }) {
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-sm border bg-muted/30 lg:aspect-video">
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-muted-foreground">
        <ImageIcon className="h-8 w-8" strokeWidth={1.25} />
        <p className="text-xs font-medium">Screenshot placeholder</p>
        <p className="max-w-xs text-center text-[11px] leading-relaxed">{hint}</p>
      </div>
    </div>
  );
}

export function Features() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="flex flex-col gap-20">
        {features.map((feature, i) => (
          <div
            key={feature.number}
            className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16"
          >
            <div className={i % 2 === 1 ? "lg:order-2" : undefined}>
              <div className="font-mono text-xs text-muted-foreground">
                {feature.number}
              </div>
              <h3 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">
                {feature.title}
              </h3>
              <p className="mt-3 text-muted-foreground">{feature.description}</p>
              {feature.bullets && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {feature.bullets.map((b) => (
                    <span
                      key={b}
                      className="rounded-sm border px-2 py-1 font-mono text-xs text-muted-foreground"
                    >
                      {b}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className={i % 2 === 1 ? "lg:order-1" : undefined}>
              <ImagePlaceholder hint={feature.imageHint} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
