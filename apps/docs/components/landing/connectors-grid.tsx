import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface Connector {
  name: string;
  icon: string;
  description: string;
  darkIcon?: boolean;
}

const CONNECTORS: Connector[] = [
  { name: "GitHub", icon: "github", description: "Read repos, open PRs, run actions", darkIcon: true },
  { name: "Linear", icon: "linear", description: "Create issues, comment, query" },
  { name: "Notion", icon: "notion", description: "Read and write pages, search DBs", darkIcon: true },
  { name: "Slack", icon: "slack", description: "Read channels, send messages" },
  { name: "Sentry", icon: "sentry", description: "Query issues and stack traces" },
  { name: "Stripe", icon: "stripe", description: "Search customers and charges" },
  { name: "Supabase", icon: "supabase", description: "Run SQL, manage projects" },
  { name: "Vercel", icon: "vercel", description: "Deployments and environments", darkIcon: true },
  { name: "Attio", icon: "attio", description: "CRM records, notes, and tasks", darkIcon: true },
];

export function ConnectorsGrid() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24 border-t">
      <div className="flex flex-col gap-4 max-w-3xl">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          Connect the agent to your stack.
        </h2>
        <p className="text-lg text-muted-foreground">
          First-class connectors for the apps your work lives in. Add any MCP server in settings.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {CONNECTORS.map((c) => (
          <div
            key={c.name}
            className="flex flex-col gap-3 p-5 rounded-lg border bg-card hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="size-8 rounded flex items-center justify-center bg-background border shrink-0">
                <img src={`/icon/connectors/${c.icon}.svg`} alt="" className={`size-5 ${c.darkIcon ? "dark:hidden" : ""}`} />
                {c.darkIcon && <img src={`/icon/connectors/${c.icon}-dark.svg`} alt="" className="size-5 hidden dark:block" />}
              </div>
              <span className="font-medium">{c.name}</span>
            </div>
            <span className="text-sm text-muted-foreground leading-relaxed">{c.description}</span>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-lg border bg-muted/30">
        <p className="text-sm text-muted-foreground">
          <strong>Open standard.</strong> Connect any tool that speaks the Model Context Protocol (MCP).
        </p>
        <Link
          href="/docs/connectors"
          className="inline-flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors whitespace-nowrap"
        >
          See connector reference
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}
