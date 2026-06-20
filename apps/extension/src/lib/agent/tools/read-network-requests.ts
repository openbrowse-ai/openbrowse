/**
 * Tool: `read_network_requests` — read HTTP request metadata captured for a tab.
 *
 * Backed by the per-tab ring buffer in `cdp-capture.ts`. Filtering, limit, and
 * clear semantics are delegated to `readNetwork`. When capture isn't active
 * for the tab, the tool returns an empty result with a `note` hinting the
 * agent to act on the page first, rather than throwing.
 */
import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";
import { readNetwork } from "../cdp-capture";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to read network requests from (e.g. 't1'). See the tab legend or call listTabs.",
    ),
  urlPattern: z
    .string()
    .optional()
    .describe(
      "Only return requests whose URL contains this substring (e.g. '/api/' to find API calls, 'example.com' to filter by domain).",
    ),
  limit: z
    .number()
    .optional()
    .describe(
      "Maximum number of requests to return (most recent N). Defaults to 100.",
    ),
  clear: z
    .boolean()
    .optional()
    .describe(
      "If true, clear the buffer after reading to avoid duplicates on the next call. Default false.",
    ),
});

type Input = z.infer<typeof parameters>;

const networkEntrySchema = z.object({
  requestId: z.string(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  fromCache: z.boolean().optional(),
  failed: z.boolean().optional(),
  errorText: z.string().optional(),
  ts: z.number(),
});

const outputSchema = z.object({
  tab: z.string(),
  requests: z.array(networkEntrySchema),
  total: z.number(),
  captured: z.boolean(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const readNetworkRequestsTool: BrowserTool<Input, Output> = {
  name: "read_network_requests",
  description:
    "Read HTTP network requests (XHR, Fetch, documents, images, etc.) a tab has made. Use to reverse-engineer the API behind a list/feed (e.g. find the paginated endpoint powering a virtualized list), debug API calls, or see what a page is fetching. Returns request metadata (url, method, type, status) — not response bodies. The buffer is captured continuously while the agent works the tab and is cleared when the page navigates to a different domain. Pass `tab` (handle from the tab legend or listTabs).",
  parameters,
  outputSchema,
  approval: { required: false },
  execute: async ({ tab: handle, urlPattern, limit, clear }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    if (tab.id == null) {
      return {
        tab: handle,
        requests: [],
        total: 0,
        captured: false,
        note: "Tab id missing",
      };
    }
    const { requests, total, captured } = readNetwork(tab.id as number, {
      ...(urlPattern !== undefined && { urlPattern }),
      ...(limit !== undefined && { limit }),
      ...(clear !== undefined && { clear }),
    });
    const note = captured
      ? undefined
      : "No network capture for this tab yet. Act on the page (e.g. scroll to trigger requests), then read again.";
    return {
      tab: handle,
      requests,
      total,
      captured,
      ...(note !== undefined && { note }),
    };
  },
};
