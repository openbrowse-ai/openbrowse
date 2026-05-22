import anthropicSvg from "@/registry/providers/icons/anthropic.svg?raw";
import anthropicDarkSvg from "@/registry/providers/icons/anthropic-dark.svg?raw";
import browserAiSvg from "@/registry/providers/icons/browser-ai.svg?raw";
import googleSvg from "@/registry/providers/icons/google.svg?raw";
import mistralSvg from "@/registry/providers/icons/mistral.svg?raw";
import ollamaSvg from "@/registry/providers/icons/ollama.svg?raw";
import ollamaDarkSvg from "@/registry/providers/icons/ollama-dark.svg?raw";
import openaiCompatibleSvg from "@/registry/providers/icons/openai-compatible.svg?raw";
import openaiSvg from "@/registry/providers/icons/openai.svg?raw";
import openaiDarkSvg from "@/registry/providers/icons/openai-dark.svg?raw";
import openrouterSvg from "@/registry/providers/icons/openrouter.svg?raw";
import webLlmSvg from "@/registry/providers/icons/web-llm.svg?raw";
import xaiSvg from "@/registry/providers/icons/xai.svg?raw";

import githubSvg from "@openbrowse/connectors/icons/github.svg?raw";
import githubDarkSvg from "@openbrowse/connectors/icons/github-dark.svg?raw";
import linearSvg from "@openbrowse/connectors/icons/linear.svg?raw";
import notionSvg from "@openbrowse/connectors/icons/notion.svg?raw";
import notionDarkSvg from "@openbrowse/connectors/icons/notion-dark.svg?raw";
import sentrySvg from "@openbrowse/connectors/icons/sentry.svg?raw";
import slackSvg from "@openbrowse/connectors/icons/slack.svg?raw";
import stripeSvg from "@openbrowse/connectors/icons/stripe.svg?raw";
import supabaseSvg from "@openbrowse/connectors/icons/supabase.svg?raw";
import vercelSvg from "@openbrowse/connectors/icons/vercel.svg?raw";
import vercelDarkSvg from "@openbrowse/connectors/icons/vercel-dark.svg?raw";

interface IconEntry {
  light: string;
  dark?: string;
}

const icons: Record<string, IconEntry> = {
  openai: { light: openaiSvg, dark: openaiDarkSvg },
  anthropic: { light: anthropicSvg, dark: anthropicDarkSvg },
  google: { light: googleSvg },
  mistral: { light: mistralSvg },
  ollama: { light: ollamaSvg, dark: ollamaDarkSvg },
  openrouter: { light: openrouterSvg },
  "openai-compatible": { light: openaiCompatibleSvg },
  "browser-ai": { light: browserAiSvg },
  "web-llm": { light: webLlmSvg },
  xai: { light: xaiSvg },
  github: { light: githubSvg, dark: githubDarkSvg },
  linear: { light: linearSvg },
  notion: { light: notionSvg, dark: notionDarkSvg },
  sentry: { light: sentrySvg },
  slack: { light: slackSvg },
  stripe: { light: stripeSvg },
  supabase: { light: supabaseSvg },
  vercel: { light: vercelSvg, dark: vercelDarkSvg },
};

interface RegistryIconProps {
  id: string;
  className?: string;
}

/** Tailwind background color classes for fallback chips, picked deterministically. */
const FALLBACK_PALETTE = [
  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
];

function fallbackChipClasses(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
}

export function RegistryIcon({ id, className = "w-4 h-4" }: RegistryIconProps) {
  const entry = icons[id];

  // No registered icon → render a colored letter chip so unknown
  // providers (e.g. newly-added models.dev entries) still get a
  // visual distinct from the rest.
  if (!entry || !entry.light) {
    const letter = (id?.[0] ?? "?").toUpperCase();
    return (
      <span
        className={`inline-flex items-center justify-center rounded-sm text-[10px] font-semibold ${fallbackChipClasses(
          id ?? "",
        )} ${className}`}
        aria-label={`${id} icon`}
      >
        {letter}
      </span>
    );
  }

  if (!entry.dark) {
    return (
      <span
        className={`inline-flex items-center justify-center ${className}`}
        dangerouslySetInnerHTML={{ __html: entry.light }}
      />
    );
  }

  return (
    <span className={`inline-flex items-center justify-center ${className}`}>
      <span className="contents dark:hidden" dangerouslySetInnerHTML={{ __html: entry.light }} />
      <span className="hidden dark:contents" dangerouslySetInnerHTML={{ __html: entry.dark }} />
    </span>
  );
}
