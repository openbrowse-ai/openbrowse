/**
 * Managed web-search proxy.
 *
 * The extension calls this endpoint (no secret) and *we* forward the query
 * to Exa using a server-side `EXA_API_KEY`. The key must never ship in the
 * extension bundle — a browser extension is fully inspectable, so an embedded
 * key would be extracted and abused. Keeping it here (a deployment env var)
 * is the whole point of the proxy.
 *
 * Protection model (v1): anonymous, best-effort IP rate limiting. No hard
 * global budget cap by request. The limiter is in-memory and therefore
 * per-instance — good enough to blunt abuse from a single client, but not a
 * distributed guarantee. Swap the `hitRateLimit` store for Vercel KV / Upstash
 * if you later want cross-instance limits.
 */

// Force the Node.js runtime + dynamic execution so the module-scope rate-limit
// map survives across warm invocations and responses are never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

// Request shaping / clamps.
const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 10;
const TEXT_MAX_CHARACTERS = 3000;
// Authoritative max query length. The extension mirrors this value for
// early client-side validation (see the web-search tool). Keep in sync.
const MAX_QUERY_LENGTH = 500;
// Upstream request timeout. The proxy must never hang a caller — or hold
// a serverless invocation open — waiting on Exa.
const UPSTREAM_TIMEOUT_MS = 10_000;

// Rate limit: per-IP sliding window.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

// Best-effort, per-instance. Maps an IP to the timestamps of its recent hits.
const rateLimitHits = new Map<string, number[]>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Returns true when the caller has exceeded its window budget. */
function hitRateLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateLimitHits.get(ip) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  rateLimitHits.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200, extra?: Record<string, string>) {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, ...extra },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface ExaResult {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  score?: number | null;
  text?: string | null;
  highlights?: string[] | null;
}

/** Forward only the fields we intend to expose. */
function normalize(r: ExaResult) {
  return {
    title: r.title ?? "",
    url: r.url ?? "",
    ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
    ...(r.author ? { author: r.author } : {}),
    ...(typeof r.score === "number" ? { score: r.score } : {}),
    ...(r.text ? { text: r.text } : {}),
    ...(Array.isArray(r.highlights) && r.highlights.length
      ? { highlights: r.highlights }
      : {}),
  };
}

export async function POST(req: Request) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    // Misconfiguration, not a client error. Don't leak specifics.
    return json({ error: "Search is not configured." }, 500);
  }

  const ip = clientIp(req);
  if (hitRateLimit(ip)) {
    return json({ error: "Rate limit exceeded. Try again shortly." }, 429, {
      "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const query =
    typeof (body as { query?: unknown })?.query === "string"
      ? (body as { query: string }).query.trim()
      : "";
  if (!query) {
    return json({ error: "Missing `query`." }, 400);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return json({ error: "Query too long." }, 400);
  }

  const rawNum = (body as { numResults?: unknown })?.numResults;
  const numResults =
    typeof rawNum === "number" && Number.isFinite(rawNum)
      ? Math.min(Math.max(Math.trunc(rawNum), 1), MAX_NUM_RESULTS)
      : DEFAULT_NUM_RESULTS;

  let exaRes: Response;
  try {
    exaRes = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        numResults,
        type: "auto",
        contents: {
          text: { maxCharacters: TEXT_MAX_CHARACTERS },
          highlights: { numSentences: 3, highlightsPerUrl: 3 },
        },
      }),
      // Bound the upstream call: abort on our own timeout OR when the
      // caller disconnects (req.signal). Prevents a hung Exa request from
      // holding the invocation open indefinitely.
      signal: AbortSignal.any([
        req.signal,
        AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ]),
    });
  } catch {
    return json({ error: "Search upstream unreachable." }, 502);
  }

  if (!exaRes.ok) {
    // Surface the upstream status for observability, but never the body
    // (it could echo request headers). Generic message to the client.
    return json({ error: `Search upstream error (${exaRes.status}).` }, 502);
  }

  let data: { results?: ExaResult[] };
  try {
    data = (await exaRes.json()) as { results?: ExaResult[] };
  } catch {
    return json({ error: "Malformed search response." }, 502);
  }

  const results = Array.isArray(data.results)
    ? data.results.map(normalize).filter((r) => r.url)
    : [];

  return json({ results });
}
