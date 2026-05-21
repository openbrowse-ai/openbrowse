import anthropicSvg from "@/registry/providers/icons/anthropic.svg?raw";
import anthropicDarkSvg from "@/registry/providers/icons/anthropic-dark.svg?raw";
import browserAiSvg from "@/registry/providers/icons/browser-ai.svg?raw";
import googleSvg from "@/registry/providers/icons/google.svg?raw";
import ollamaSvg from "@/registry/providers/icons/ollama.svg?raw";
import ollamaDarkSvg from "@/registry/providers/icons/ollama-dark.svg?raw";
import openaiCompatibleSvg from "@/registry/providers/icons/openai-compatible.svg?raw";
import openaiSvg from "@/registry/providers/icons/openai.svg?raw";
import openaiDarkSvg from "@/registry/providers/icons/openai-dark.svg?raw";
import webLlmSvg from "@/registry/providers/icons/web-llm.svg?raw";

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
  ollama: { light: ollamaSvg, dark: ollamaDarkSvg },
  "openai-compatible": { light: openaiCompatibleSvg },
  "browser-ai": { light: browserAiSvg },
  "web-llm": { light: webLlmSvg },
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

export function RegistryIcon({ id, className = "w-4 h-4" }: RegistryIconProps) {
  const entry = icons[id];
  if (!entry) return null;

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
