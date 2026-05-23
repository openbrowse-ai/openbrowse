import { generateText } from "ai";
import TurndownService from "turndown";
import { z } from "zod";
import type { BrowserTool } from "../types";

// Lazy-loaded to avoid pulling agent-transport (and its chrome.* dependencies)
// into module init for tests / non-runtime contexts.
async function loadCurrentAgentModel() {
  const mod = await import("../agent-transport");
  return mod.getCurrentAgentModel();
}

// ============================================================================
// Constants
// ============================================================================

/** Hard ceiling on response body bytes read from the network. */
const MAX_RAW_BYTES = 5 * 1024 * 1024; // 5 MB

/** Output character threshold above which we summarize via the agent's LLM. */
const SUMMARIZATION_THRESHOLD = 100_000;

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;

/** Schemes we refuse to fetch. */
const BLOCKED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "file:",
  "javascript:",
  "data:",
  "about:",
  "blob:",
  "ftp:",
  "view-source:",
]);

/**
 * Content-types that we treat as "already text-shaped" and pass through
 * without DOM parsing. Anything outside this set + not text/html is also
 * passed through verbatim.
 */
const TEXTLIKE_NON_HTML = /^(application\/json|application\/xml|text\/(plain|csv|xml|markdown|css|javascript|x-[a-z]+))/i;

const HTML_LIKE = /^(text\/html|application\/xhtml\+xml)/i;

// ============================================================================
// Schema
// ============================================================================

const parameters = z.object({
  url: z
    .string()
    .url()
    .describe(
      "URL to fetch. Must be a fully-formed URL (with scheme). http:// is auto-upgraded to https://.",
    ),
  format: z
    .enum(["markdown", "text", "html"])
    .optional()
    .describe(
      "Output format for HTML responses. 'markdown' (default) converts to GitHub-flavored markdown. 'text' returns plain text (innerText). 'html' returns the raw HTML body. Non-HTML responses (JSON, plain text, etc.) are returned verbatim regardless of this flag.",
    ),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(
      `Request timeout in seconds. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`,
    ),
});

type Input = z.infer<typeof parameters>;

type Output = {
  url: string;
  status: number;
  contentType: string;
  format: "markdown" | "text" | "html";
  content: string;
  summarized: boolean;
  originalLength?: number;
  /** True if the final URL ended up on a different host than requested. */
  redirected?: boolean;
  /** Original URL the request was sent to, present only when redirected. */
  redirectedFrom?: string;
};

// ============================================================================
// Helpers
// ============================================================================

function upgradeHttp(rawUrl: string): string {
  if (rawUrl.startsWith("http://")) return "https://" + rawUrl.slice(7);
  return rawUrl;
}

function assertSchemeAllowed(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`webFetch: invalid URL: ${rawUrl}`);
  }
  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `webFetch: refusing to fetch blocked scheme '${parsed.protocol}': ${rawUrl}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `webFetch: only http/https URLs are supported (got '${parsed.protocol}')`,
    );
  }
  return parsed;
}

/**
 * Read a Response body, accumulating chunks up to MAX_RAW_BYTES. Throws if
 * the body exceeds the cap. Returns the full text as a UTF-8 string.
 *
 * Falls back to res.text() when the body isn't streamable (e.g. in some
 * test mocks). Even in the fallback path we still enforce the byte cap.
 */
async function readBodyCapped(res: Response): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_RAW_BYTES) {
      throw new Error(
        `webFetch: response too large (Content-Length ${n} > ${MAX_RAW_BYTES} bytes / 5MB cap)`,
      );
    }
  }

  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    // Use TextEncoder for accurate byte count rather than char length.
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_RAW_BYTES) {
      throw new Error(
        `webFetch: response too large (${bytes} bytes exceeded ${MAX_RAW_BYTES} bytes / 5MB cap)`,
      );
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RAW_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        throw new Error(
          `webFetch: response too large (exceeded ${MAX_RAW_BYTES} bytes / 5MB cap during streaming read)`,
        );
      }
      chunks.push(value);
    }
  }
  // Concatenate and decode as UTF-8.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Issue a fetch with `redirect: "follow"` and report whether the final
 * URL ended up on a different host than the request.
 *
 * Why not `redirect: "manual"` for cross-host detection? In a browser
 * context, manual-mode responses are opaque-redirect: status is 0, the
 * `Location` header is unreadable, and the response body is empty. So
 * we cannot inspect the redirect target before deciding whether to
 * follow. Letting the browser follow handles the same-host hop limit
 * for us, and `response.url` reflects the final destination — that's
 * enough to inform the caller of any host change.
 */
async function fetchAndFollow(
  initialUrl: string,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string; redirected: boolean }> {
  let initialHost: string;
  try {
    initialHost = new URL(initialUrl).host;
  } catch {
    throw new Error(`webFetch: invalid URL: ${initialUrl}`);
  }

  const response = await fetch(initialUrl, {
    redirect: "follow",
    credentials: "omit",
    signal,
  });

  const finalUrl = response.url || initialUrl;
  let redirected = false;
  try {
    redirected = new URL(finalUrl).host !== initialHost;
  } catch {
    // Final URL was somehow unparseable; treat as not-redirected rather
    // than throw — we still got a Response and can return its body.
  }

  return { response, finalUrl, redirected };
}

function stripNoiseTags(doc: Document): void {
  doc
    .querySelectorAll("script, style, noscript, iframe, svg")
    .forEach((n) => n.remove());
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  stripNoiseTags(doc);
  const text = doc.body?.innerText ?? doc.body?.textContent ?? "";
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  stripNoiseTags(doc);
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return td.turndown(doc.body ?? doc.documentElement);
}

const SUMMARIZATION_SYSTEM_PROMPT = `You summarize fetched web pages for an AI agent that needs the contents but cannot fit the full page in its context.

Rules:
- Preserve URLs verbatim (do not omit or rewrite links).
- Preserve headings, code blocks, and key technical details.
- Preserve numerical facts, version numbers, and identifiers.
- Be terse: drop boilerplate, navigation, ads, footer, and repeated content.
- Output as markdown.
- Do NOT add commentary about what you summarized — just emit the summary.`;

async function summarizeIfNeeded(
  content: string,
  url: string,
): Promise<{ content: string; summarized: boolean; originalLength?: number }> {
  if (content.length <= SUMMARIZATION_THRESHOLD) {
    return { content, summarized: false };
  }

  const model = await loadCurrentAgentModel();
  if (!model) {
    // Invariant violation: tool runs only while the agent runs. Fall back to
    // truncation rather than failing — the agent still gets useful prefix.
    const truncated =
      content.slice(0, SUMMARIZATION_THRESHOLD) +
      `\n\n[...content truncated; original ${content.length} chars; LLM summarization unavailable]`;
    return {
      content: truncated,
      summarized: false,
      originalLength: content.length,
    };
  }

  try {
    const { text } = await generateText({
      model,
      system: SUMMARIZATION_SYSTEM_PROMPT,
      prompt: `Summarize the following page contents fetched from ${url}:\n\n${content}`,
    });
    return {
      content: text,
      summarized: true,
      originalLength: content.length,
    };
  } catch (err) {
    // Summarization failed — fall back to truncation with a note so the
    // agent knows what happened.
    const note = err instanceof Error ? err.message : String(err);
    const truncated =
      content.slice(0, SUMMARIZATION_THRESHOLD) +
      `\n\n[...content truncated; original ${content.length} chars; summarization failed: ${note}]`;
    return {
      content: truncated,
      summarized: false,
      originalLength: content.length,
    };
  }
}

// ============================================================================
// Tool
// ============================================================================

export const webFetchTool: BrowserTool<Input, Output> = {
  name: "webFetch",
  description:
    "Fetch a URL and return its contents as markdown (default), plain text, or raw HTML. Use this to read documentation, articles, or APIs WITHOUT navigating the user's active tab. http:// URLs are auto-upgraded to https://. Redirects are followed automatically; if the final URL ends up on a different host, the response includes `redirected: true` and `redirectedFrom` so you can confirm the destination. Oversized responses are summarized via the agent's own model. Read-only — no side effects, no user cookies sent.",
  parameters,
  execute: async (input) => {
    const parsed = parameters.parse(input);
    const format = parsed.format ?? "markdown";
    const timeoutS = parsed.timeout ?? DEFAULT_TIMEOUT_S;

    // Validate scheme on the user-supplied URL first (before HTTPS upgrade)
    // so that http: passes through to the upgrade step but everything else
    // is rejected with a clear message.
    assertSchemeAllowed(parsed.url);
    const requestUrl = upgradeHttp(parsed.url);
    // Re-validate after upgrade just to be safe.
    assertSchemeAllowed(requestUrl);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutS * 1000);

    let response: Response;
    let finalUrl: string;
    let redirected: boolean;
    try {
      ({ response, finalUrl, redirected } = await fetchAndFollow(
        requestUrl,
        controller.signal,
      ));
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`webFetch: timed out after ${timeoutS}s`);
      }
      if (err instanceof Error && /aborted|AbortError/i.test(err.name + " " + err.message)) {
        throw new Error(`webFetch: timed out after ${timeoutS}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      throw new Error(
        `webFetch: HTTP ${response.status} ${response.statusText} for ${finalUrl}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readBodyCapped(response);

    // Decide whether to DOM-parse this response.
    const isHtml = HTML_LIKE.test(contentType);
    let content: string;
    let effectiveFormat: "markdown" | "text" | "html" = format;

    if (format === "html" || !isHtml) {
      // Either the user asked for raw HTML, or this isn't HTML at all
      // (JSON, plain text, XML, etc.) — pass through verbatim.
      content = body;
      // Reflect the actual format we're emitting. If the user asked for
      // markdown but we're returning JSON, we still call it "html" (the
      // raw/passthrough mode) so the agent doesn't expect markdown.
      if (!isHtml && format === "markdown") {
        effectiveFormat = TEXTLIKE_NON_HTML.test(contentType) ? "text" : "html";
      }
    } else if (format === "text") {
      content = htmlToText(body);
    } else {
      // format === "markdown" && isHtml
      content = htmlToMarkdown(body);
    }

    const sized = await summarizeIfNeeded(content, finalUrl);

    return {
      url: finalUrl,
      status: response.status,
      contentType,
      format: effectiveFormat,
      content: sized.content,
      summarized: sized.summarized,
      ...(sized.originalLength != null
        ? { originalLength: sized.originalLength }
        : {}),
      ...(redirected
        ? { redirected: true, redirectedFrom: requestUrl }
        : {}),
    };
  },
};
