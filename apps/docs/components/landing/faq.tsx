import { ChevronDown, ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface QA {
  q: string;
  a: string;
}

const faqs: QA[] = [
  {
    q: "What is OpenBrowse?",
    a: "OpenBrowse is a free, open source Chrome extension that puts an AI agent in your browser. It can read pages, click, navigate, run code, and connect to external services via MCP — all under your control, with any model you choose.",
  },
  {
    q: "How is this different from Claude for Chrome, Gemini in Chrome, or Perplexity Comet?",
    a: "Those are closed, single-vendor products tied to one model. OpenBrowse is open source and model-agnostic — use Claude, GPT, Gemini, a local model via WebLLM, or Chrome's built-in Gemini Nano. You bring your own key, or run with no key at all.",
  },
  {
    q: "Is my data private?",
    a: "OpenBrowse runs locally as a Chrome extension. Page content and conversations are only sent to the AI provider you pick — if you use a local model, nothing leaves your machine. We don't run a server and don't collect usage data.",
  },
  {
    q: "Do I need an API key?",
    a: "No. OpenBrowse ships with support for Chrome Built-in AI (Gemini Nano) and WebLLM, both of which run fully on-device with no key. If you want a more capable cloud model, you can plug in your own key for OpenAI, Anthropic, Google, or any OpenAI-compatible provider.",
  },
  {
    q: "Is OpenBrowse open source?",
    a: "Yes. OpenBrowse is MIT licensed. Contributions are welcome.",
  },
];

export function FAQ() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-24">
      <div className="flex items-end justify-between mb-8">
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">FAQ</h2>
        <Link href="/docs/faq" className="text-sm font-medium hover:text-primary transition-colors inline-flex items-center gap-1">
          See all FAQs <ArrowRight className="size-4" />
        </Link>
      </div>
      <div className="divide-y border-y">
        {faqs.map((item) => (
          <Collapsible key={item.q} className="group py-4">
            <CollapsibleTrigger className="flex w-full cursor-pointer list-none items-center justify-between gap-4 text-left">
              <span className="font-medium">{item.q}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {item.a}
              </p>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </section>
  );
}
