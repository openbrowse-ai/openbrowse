import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webFetchTool } from "./web-fetch";

// We test the parts of web-fetch that don't require a DOM:
//   - URL validation, scheme blocking, HTTPS upgrade
//   - Redirect handling (cross-host vs same-host)
//   - Timeout via AbortController
//   - Body byte cap
//   - Content-type-based bypass of DOM parsing
//   - format: "html" (raw passthrough)
//
// HTML → markdown / text conversion paths are exercised via manual smoke
// testing in the loaded extension because the test env is "node" and we
// don't ship DOM-test infrastructure in this repo.

type MockResponseInit = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  url?: string; // final URL after redirect
};

function makeResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  const body = init.body ?? "";
  // Build a Response. We override `url` via a Proxy because Response.url is
  // read-only in node's undici impl when constructed directly.
  const base = new Response(body, { status, headers });
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "url") return init.url ?? "";
      return Reflect.get(target, prop, receiver);
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webFetch — URL validation & scheme blocking", () => {
  it("rejects chrome:// URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "chrome://settings" } as never),
    ).rejects.toThrow(/blocked scheme|invalid|url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects file:// URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "file:///etc/passwd" } as never),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects javascript: URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "javascript:alert(1)" } as never),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects data: URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "data:text/plain,hello" } as never),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "not a url" } as never),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("webFetch — HTTPS upgrade", () => {
  it("upgrades http:// to https:// before fetching", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "ok",
        url: "https://example.com/",
      }),
    );

    await webFetchTool.execute({
      url: "http://example.com/",
      format: "html",
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://example.com/");
  });
});

describe("webFetch — non-2xx handling", () => {
  it("throws on 404 with status in error message", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 404,
        headers: { "content-type": "text/html" },
        body: "Not Found",
        url: "https://example.com/missing",
      }),
    );

    await expect(
      webFetchTool.execute({
        url: "https://example.com/missing",
      } as never),
    ).rejects.toThrow(/404/);
  });

  it("throws on 500", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 500,
        headers: {},
        body: "Server Error",
        url: "https://example.com/",
      }),
    );

    await expect(
      webFetchTool.execute({ url: "https://example.com/" } as never),
    ).rejects.toThrow(/500/);
  });
});

describe("webFetch — redirect handling", () => {
  it("follows cross-host redirects transparently and reports redirected=true", async () => {
    // With redirect: "follow", fetch handles all hops; the final response
    // arrives with response.url pointing at the destination host.
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "destination body",
        url: "https://www.example.com/landing",
      }),
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com/",
      format: "html",
    } as never)) as {
      url: string;
      content: string;
      status: number;
      redirected?: boolean;
      redirectedFrom?: string;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.url).toBe("https://www.example.com/landing");
    expect(result.content).toBe("destination body");
    expect(result.redirected).toBe(true);
    expect(result.redirectedFrom).toBe("https://example.com/");
  });

  it("does not flag redirected=true when the final URL is on the same host", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "final body",
        url: "https://example.com/v2/page",
      }),
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com/page",
      format: "html",
    } as never)) as {
      content: string;
      status: number;
      redirected?: boolean;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.content).toBe("final body");
    expect(result.redirected).toBeUndefined();
  });

  it("issues a single fetch — browser handles redirect chains internally", async () => {
    // Sanity check that we are NOT manually walking redirect chains; the
    // older redirect:"manual" implementation broke in real browsers
    // because manual-mode responses are opaque (status: 0). With
    // redirect:"follow", one fetch call yields the final response.
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "ok",
        url: "https://example.com/final",
      }),
    );

    await webFetchTool.execute({
      url: "https://example.com/start",
      format: "html",
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("follow");
  });
});

describe("webFetch — content-type handling", () => {
  it("returns non-HTML bodies verbatim regardless of requested format", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
        url: "https://api.example.com/x",
      }),
    );

    const result = (await webFetchTool.execute({
      url: "https://api.example.com/x",
      format: "markdown",
    } as never)) as { content: string; contentType: string };

    expect(result.content).toBe('{"hello":"world"}');
    expect(result.contentType).toContain("application/json");
  });

  it("format='html' returns body verbatim", async () => {
    const html = "<html><body><h1>Hi</h1></body></html>";
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: html,
        url: "https://example.com/",
      }),
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com/",
      format: "html",
    } as never)) as { content: string; format: string };

    expect(result.format).toBe("html");
    expect(result.content).toBe(html);
  });
});

describe("webFetch — timeout", () => {
  it("aborts after the configured timeout", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    await expect(
      webFetchTool.execute({
        url: "https://example.com/",
        timeout: 1, // 1 second
      } as never),
    ).rejects.toThrow(/timed out|timeout|abort/i);
  }, 5000);
});

describe("webFetch — body byte cap", () => {
  it("rejects responses larger than the raw byte cap", async () => {
    // 6 MB > 5 MB cap. Build a string and rely on the implementation's
    // streaming reader to detect overflow.
    const huge = "x".repeat(6 * 1024 * 1024);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(huge.length),
        },
        body: huge,
        url: "https://example.com/big",
      }),
    );

    await expect(
      webFetchTool.execute({
        url: "https://example.com/big",
        format: "html",
      } as never),
    ).rejects.toThrow(/too large|exceeded|5 ?MB/i);
  });
});

describe("webFetch — tool metadata", () => {
  it("declares the expected name", () => {
    expect(webFetchTool.name).toBe("webFetch");
  });

  it("does not require approval", () => {
    expect(webFetchTool.approval?.required ?? false).toBe(false);
  });

  it("has a description that mentions the format options", () => {
    expect(webFetchTool.description).toMatch(/markdown/i);
    expect(webFetchTool.description).toMatch(/text/i);
    expect(webFetchTool.description).toMatch(/html/i);
  });
});
