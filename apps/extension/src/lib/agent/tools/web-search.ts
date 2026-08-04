import { z } from "zod";
import type { BrowserTool } from "../types";

/**
 * Managed web search.
 *
 * Calls OpenBrowse's hosted search proxy (`/api/search`), which forwards the
 * query to Exa using a server-side key. No secret lives in the extension —
 * the proxy holds and protects the key. See `apps/docs/app/api/search/route.ts`.
 *
 * This is the fast "find" layer: it returns ranked results with a text excerpt
 * and highlighted snippets, which is enough for discovery and quick answers.
 * For deep reading, or for anything behind login / requiring interaction, the
 * agent should follow up with `navigate` + `readPage`/`extract` — those reach
 * the authenticated, interactive web that a public search index cannot.
 */
/**
 * Endpoint resolution:
 *   1. `WXT_PUBLIC_SEARCH_ENDPOINT` env var wins if set (any host/port).
 *   2. In `wxt dev` builds → local proxy on :3001.
 *   3. Production builds → the hosted proxy.
 *
 * Dev uses :3001 (not :3000) because WXT's own dev server binds :3000 —
 * run the docs proxy with `-p 3001`. Override the URL entirely by creating
 * `apps/extension/.env` with:
 *   WXT_PUBLIC_SEARCH_ENDPOINT=http://localhost:4000/api/search
 */
const ENV = import.meta.env as unknown as {
  MODE?: string;
  WXT_PUBLIC_SEARCH_ENDPOINT?: string;
};

const SEARCH_ENDPOINT: string =
  ENV.WXT_PUBLIC_SEARCH_ENDPOINT ||
  (ENV.MODE === "development"
    ? "http://localhost:3001/api/search"
    : "https://openbrowse.ai/api/search");

const REQUEST_TIMEOUT_MS = 20_000;

const parameters = z
  .object({
    query: z.string().min(1).describe("The web search query."),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many results to return (default 8, max 10)."),
  })
  .strict();

type Input = z.infer<typeof parameters>;

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  publishedDate: z.string().optional(),
  author: z.string().optional(),
  score: z.number().optional(),
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
});

const outputSchema = z.object({
  results: z.array(resultSchema),
  error: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const webSearchTool: BrowserTool<Input, Output> = {
  name: "webSearch",
  description:
    "Search the web via OpenBrowse's hosted search. Returns ranked results with title, URL, a text excerpt, and highlighted snippets — use it for discovery and quick answers. For deep reading, or for pages behind login or requiring interaction, follow up with `navigate` + `readPage`/`extract`.",
  parameters,
  outputSchema,
  execute: async ({ query, numResults }, ctx) => {
    // Bound the request and honor the agent loop's abort signal.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const res = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, ...(numResults ? { numResults } : {}) }),
        signal: controller.signal,
      });

      const data = (await res.json().catch(() => null)) as {
        results?: unknown;
        error?: unknown;
      } | null;

      if (!res.ok) {
        const message =
          data && typeof data.error === "string"
            ? data.error
            : `Search failed (${res.status}).`;
        return { results: [], error: message };
      }

      const parsed = outputSchema.safeParse({
        results: Array.isArray(data?.results) ? data!.results : [],
      });
      if (!parsed.success) {
        return { results: [], error: "Malformed search response." };
      }
      return parsed.data;
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Search timed out."
          : err instanceof Error
            ? err.message
            : "Search request failed.";
      return { results: [], error: message };
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};
