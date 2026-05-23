import type { BenchmarkTask } from "./types";

/**
 * A tiny seed suite used while the harness is being bootstrapped. Real
 * benchmark suites (WebBench) live in their own files —
 * this set exists so the harness can be smoke-tested end-to-end without
 * pulling external data.
 */
export const SMOKE_TASKS: BenchmarkTask[] = [
  {
    id: "example-com-heading",
    instruction:
      "Navigate to example.com and respond with ONLY the exact text of the page's main heading. No prose, no quotes, no markdown — just the heading text on a single line.",
    startUrl: "https://example.com",
    category: "extraction",
    source: "custom",
    evaluator: {
      kind: "exact-match",
      expected: "Example Domain",
    },
    timeoutMs: 60_000,
    maxSteps: 10,
    notes:
      "Smoke test: deterministic page, single h1, no JS. If this fails the harness is broken, not the agent. The instruction is deliberately strict about output format so exact-match can apply — most real tasks should use llm-judge.",
  },
  {
    id: "wikipedia-typescript-first-paragraph",
    instruction:
      "Go to the Wikipedia article on TypeScript and return the first sentence of the article in plain text.",
    startUrl: "https://en.wikipedia.org/wiki/TypeScript",
    category: "extraction",
    source: "custom",
    evaluator: {
      kind: "llm-judge",
      rubric:
        "The agent's answer should be the first sentence (or close paraphrase) of the Wikipedia TypeScript article. Accept reasonable variations in punctuation and whitespace. Reject answers that quote later paragraphs or summarize the whole article.",
    },
    timeoutMs: 90_000,
    maxSteps: 12,
  },
];
