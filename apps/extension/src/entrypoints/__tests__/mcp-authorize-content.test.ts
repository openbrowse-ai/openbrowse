// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcp-authorize.content", () => {
  it("declares matches for http://localhost:47821/authorize* and 127.0.0.1 variant", async () => {
    const mod = await import("../mcp-authorize.content");
    const cs = (mod as { default: { matches: string[] } }).default;
    expect(cs.matches).toEqual(
      expect.arrayContaining([
        expect.stringContaining("localhost:47821/authorize"),
      ]),
    );
  });
});

describe("mcp-authorize.content — Phase 2 consent UI", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-openbrowse-authorize
        data-client-id="c1"
        data-client-name="Cursor"
        data-state="s1"
        data-scope="task read_page"
        data-redirect-url="http://127.0.0.1:9999/cb?code=ABC&state=s1">
        <h1>Cursor wants to access OpenBrowse</h1>
        <p class="progress" data-openbrowse-status>Waiting for consent…</p>
        <div data-openbrowse-consent style="display: none;">
          <button data-action="allow">Allow</button>
          <button data-action="deny">Deny</button>
        </div>
      </div>
    `;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn(async (msg: { type: string; decision?: string }) => {
          if (msg.type === "MCP_BRIDGE_CONSENT_DECISION") {
            return {
              ok: true,
              redirectUrl:
                msg.decision === "allow"
                  ? "http://127.0.0.1:9999/cb?code=ABC&state=s1"
                  : "http://127.0.0.1:9999/cb?error=access_denied&state=s1",
            };
          }
          return { ok: true };
        }),
      },
    };
    vi.resetModules();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it("unhides the consent block on load", async () => {
    const mod = await import("../mcp-authorize.content");
    await (mod as { main: () => void | Promise<void> }).main();
    const consent = document.querySelector(
      "[data-openbrowse-consent]",
    ) as HTMLElement;
    expect(consent.style.display).not.toBe("none");
  });

  it("Allow click sends MCP_BRIDGE_CONSENT_DECISION allow + redirects to code URL", async () => {
    const replaceMock = vi.fn();
    Object.defineProperty(window.location, "replace", {
      value: replaceMock,
      writable: true,
    });
    const mod = await import("../mcp-authorize.content");
    await (mod as { main: () => void | Promise<void> }).main();
    (
      document.querySelector("[data-action='allow']") as HTMLButtonElement
    ).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
        .chrome.runtime.sendMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MCP_BRIDGE_CONSENT_DECISION",
        decision: "allow",
        state: "s1",
        redirectUrlWithCode: "http://127.0.0.1:9999/cb?code=ABC&state=s1",
      }),
    );
    expect(replaceMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/cb?code=ABC&state=s1",
    );
  });

  it("Deny click redirects to error URL", async () => {
    const replaceMock = vi.fn();
    Object.defineProperty(window.location, "replace", {
      value: replaceMock,
      writable: true,
    });
    const mod = await import("../mcp-authorize.content");
    await (mod as { main: () => void | Promise<void> }).main();
    (
      document.querySelector("[data-action='deny']") as HTMLButtonElement
    ).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(replaceMock).toHaveBeenCalledWith(
      expect.stringContaining("error=access_denied"),
    );
  });
});
