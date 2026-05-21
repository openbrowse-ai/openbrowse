import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface Provider {
  name: string;
  icon: string;
  type: "cloud" | "on-device" | "self-hosted";
  href: string;
  darkIcon?: boolean;
}

const PROVIDERS: Provider[] = [
  { name: "OpenAI", icon: "openai", type: "cloud", href: "/docs/models-and-providers/openai", darkIcon: true },
  { name: "Anthropic", icon: "anthropic", type: "cloud", href: "/docs/models-and-providers/anthropic", darkIcon: true },
  { name: "Google Gemini", icon: "google", type: "cloud", href: "/docs/models-and-providers/google" },
  { name: "Chrome Built-in AI", icon: "browser-ai", type: "on-device", href: "/docs/models-and-providers/chrome-ai" },
  { name: "WebLLM", icon: "web-llm", type: "on-device", href: "/docs/models-and-providers/web-llm", darkIcon: true },
  { name: "Ollama", icon: "ollama", type: "self-hosted", href: "/docs/models-and-providers/ollama", darkIcon: true },
];

export function CompatibilityGrid() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="flex flex-col gap-4 max-w-3xl">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          Any model. Cloud, self-hosted, or on-device.
        </h2>
        <p className="text-lg text-muted-foreground">
          Plug in OpenAI, Anthropic, or Gemini with your own key. Or run models entirely on your machine with WebLLM, Ollama, or Chrome Built-in AI.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-4">
        {PROVIDERS.map((p) => (
          <Link
            key={p.name}
            href={p.href}
            className="flex items-center gap-3 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors group"
          >
            <div className="size-8 rounded flex items-center justify-center bg-background border shrink-0">
              <img src={`/icon/providers/${p.icon}.svg`} alt="" className={`size-5 ${p.darkIcon ? "dark:hidden" : ""}`} />
              {p.darkIcon && <img src={`/icon/providers/${p.icon}-dark.svg`} alt="" className="size-5 hidden dark:block" />}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate">{p.name}</span>
              <span className="text-[11px] text-muted-foreground capitalize">{p.type}</span>
            </div>
          </Link>
        ))}
        
        {/* OpenAI Compatible catch-all */}
        <Link
          href="/docs/models-and-providers/openai-compatible"
          className="col-span-2 md:col-span-2 flex flex-col justify-center gap-1 p-4 rounded-lg border border-dashed bg-transparent hover:bg-muted/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img src="/icon/providers/openai-compatible.svg" alt="" className="size-5 opacity-60 dark:hidden" />
              <img src="/icon/providers/openai-compatible-dark.svg" alt="" className="size-5 opacity-60 hidden dark:block" />
              <span className="text-sm font-medium">OpenAI-Compatible</span>
            </div>
            <ArrowRight className="size-4 text-muted-foreground opacity-0 -translate-x-2 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
          </div>
          <span className="text-xs text-muted-foreground">Groq, Together, Mistral, or any custom URL</span>
        </Link>
      </div>
    </section>
  );
}
