/**
 * Wiring test: `createAgentTransport` must hand the conversation's id to the
 * provider as the request session id. The provider-level tests prove what the
 * session id becomes on the wire; this proves the agent actually supplies it
 * (and the right one), using the real transport builder and the real
 * `opencode-go` registry entry.
 *
 * `createLanguageModel` is spied and made to throw a sentinel right after the
 * arguments are captured, so the transport stops before building tools, MCP
 * and the rest — no network, no API key, nothing to clean up.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../types";
import { createAgentTransport } from "../agent-transport";

const SENTINEL = "stop-after-model-creation";
const MODEL = "opencode-go:deepseek-v4-flash";

const settings = {
  providerConfigs: { "opencode-go": { apiKey: "test-key-not-real" } },
} as unknown as Settings;

async function spyOnGo() {
  const { providers } = await import("@/registry/providers");
  const go = providers.find((p) => p.id === "opencode-go");
  if (!go) throw new Error("opencode-go missing from the registry");
  return vi.spyOn(go, "createLanguageModel").mockRejectedValue(new Error(SENTINEL));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAgentTransport session wiring", () => {
  it("passes the conversation id as the session id", async () => {
    const spy = await spyOnGo();

    await expect(
      createAgentTransport(settings, MODEL, null, null, "conv-123"),
    ).rejects.toThrow(SENTINEL);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      { apiKey: "test-key-not-real" },
      "deepseek-v4-flash",
      { sessionId: "conv-123" },
    );
  });

  it("uses the same id on the next turn's freshly built transport, and another id for another conversation", async () => {
    const spy = await spyOnGo();

    for (const cid of ["conv-a", "conv-a", "conv-b"]) {
      await expect(
        createAgentTransport(settings, MODEL, null, null, cid),
      ).rejects.toThrow(SENTINEL);
    }

    const sessionIds = spy.mock.calls.map((c) => c[2]?.sessionId);
    expect(sessionIds).toEqual(["conv-a", "conv-a", "conv-b"]);
  });

  it("supplies no session id (rather than inventing one) when no conversation is known", async () => {
    const spy = await spyOnGo();

    await expect(
      createAgentTransport(settings, MODEL, null, null, null),
    ).rejects.toThrow(SENTINEL);

    expect(spy.mock.calls[0][2]).toEqual({});
  });
});
