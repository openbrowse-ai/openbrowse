import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../driver/tool-context";
import { webSearchTool } from "../web-search";

const ctx: ToolContext = { driver: {} as ToolContext["driver"] };

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe("webSearch tool", () => {
  it("POSTs the query to the managed proxy (no api key in the request)", async () => {
    const fetchMock = mockFetch(200, { results: [] });
    await webSearchTool.execute({ query: "openbrowse" }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openbrowse.ai/api/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ query: "openbrowse" });
    // The extension must never carry the Exa key.
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "x-api-key",
    );
  });

  it("forwards numResults when provided", async () => {
    const fetchMock = mockFetch(200, { results: [] });
    await webSearchTool.execute({ query: "q", numResults: 5 }, ctx);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      query: "q",
      numResults: 5,
    });
  });

  it("normalizes results through the output schema", async () => {
    mockFetch(200, {
      results: [
        {
          title: "Example",
          url: "https://example.com",
          text: "hello",
          highlights: ["hi"],
          score: 0.9,
        },
      ],
    });
    const out = await webSearchTool.execute({ query: "q" }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.results).toEqual([
      {
        title: "Example",
        url: "https://example.com",
        text: "hello",
        highlights: ["hi"],
        score: 0.9,
      },
    ]);
  });

  it("returns an error (not a throw) on non-2xx", async () => {
    mockFetch(429, { error: "Rate limit exceeded. Try again shortly." });
    const out = await webSearchTool.execute({ query: "q" }, ctx);
    expect(out.results).toEqual([]);
    expect(out.error).toBe("Rate limit exceeded. Try again shortly.");
  });

  it("returns an error when the network call throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    );
    const out = await webSearchTool.execute({ query: "q" }, ctx);
    expect(out.results).toEqual([]);
    expect(out.error).toBe("boom");
  });
});
