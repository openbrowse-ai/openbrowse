import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * executePython approval is network-conditional: a sandboxed run (no
 * `allow_network`, the default) is as safe as the always-available fs tools
 * and must NOT prompt; a run that requests outbound network access MUST
 * prompt the human.
 *
 * In headless (scheduled) runs there's no human:
 *  - autoApprove: true  → no prompt, network allowed (task author opted in).
 *  - autoApprove: false → tool stays available (sandboxed) but `allow_network`
 *    is forced off in the execute wrapper, so the model can't reach the
 *    network unattended.
 */

const CID = "conv-python-approval";

function installChromeStub() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: () => Promise.resolve({ ok: true }),
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: () => {}, removeListener: () => {} },
      get: (id: number) => Promise.resolve({ id, url: "https://x.test/", title: "x" }),
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(undefined),
    },
    storage: {
      local: {
        get: (key?: string | string[]) => {
          if (typeof key === "string")
            return Promise.resolve({ [key]: store[key] });
          return Promise.resolve({ ...store });
        },
        set: (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    debugger: {
      onDetach: { addListener: () => {}, removeListener: () => {} },
      onEvent: { addListener: () => {}, removeListener: () => {} },
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
    },
    scripting: {
      executeScript: () => Promise.resolve([]),
      insertCSS: () => Promise.resolve(),
    },
  });
}

describe("executePython approval (network-conditional)", () => {
  beforeEach(() => {
    installChromeStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function buildNeedsApproval() {
    const { toSDKTool, setAgentContext, clearHeadlessRunPolicy } = await import(
      "@/lib/agent/agent-transport"
    );
    const { createPythonTool } = await import("@/lib/agent/tools");
    setAgentContext(CID);
    clearHeadlessRunPolicy(CID);
    const tool = toSDKTool(createPythonTool(), "executePython");
    const needsApproval = tool.needsApproval as (
      input: unknown,
      options: { toolCallId: string; messages: unknown[] },
    ) => Promise<boolean> | boolean;
    return { needsApproval };
  }

  const opts = { toolCallId: "call-1", messages: [] as unknown[] };

  it("requires approval when allow_network: true", async () => {
    const { needsApproval } = await buildNeedsApproval();
    expect(await needsApproval({ code: "1", allow_network: true }, opts)).toBe(
      true,
    );
  });

  it("does NOT require approval when allow_network: false", async () => {
    const { needsApproval } = await buildNeedsApproval();
    expect(await needsApproval({ code: "1", allow_network: false }, opts)).toBe(
      false,
    );
  });

  it("does NOT require approval when allow_network is omitted (sandboxed default)", async () => {
    const { needsApproval } = await buildNeedsApproval();
    expect(await needsApproval({ code: "1" }, opts)).toBe(false);
  });

  it("auto-approve headless run skips the prompt even with allow_network: true", async () => {
    const { toSDKTool, setAgentContext, setHeadlessRunPolicy } = await import(
      "@/lib/agent/agent-transport"
    );
    const { createPythonTool } = await import("@/lib/agent/tools");
    setAgentContext(CID);
    setHeadlessRunPolicy(CID, { autoApprove: true });
    const tool = toSDKTool(createPythonTool(), "executePython");
    const needsApproval = tool.needsApproval as (
      input: unknown,
      o: typeof opts,
    ) => Promise<boolean> | boolean;
    expect(await needsApproval({ code: "1", allow_network: true }, opts)).toBe(
      false,
    );
  });
});

describe("executePython headless network sanitization", () => {
  beforeEach(() => {
    installChromeStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /**
   * A stub BrowserTool keyed as "executePython" that records the input its
   * `execute` actually receives. The wrapper's sanitization runs against the
   * tool KEY, not the tool instance, so a stub is sufficient to exercise it
   * without dragging in the Pyodide/offscreen RPC stack.
   */
  async function runWithPolicy(
    policy: { autoApprove: boolean } | null,
    input: Record<string, unknown>,
  ) {
    const { z } = await import("zod");
    const {
      toSDKTool,
      setAgentContext,
      setHeadlessRunPolicy,
      clearHeadlessRunPolicy,
    } = await import("@/lib/agent/agent-transport");

    setAgentContext(CID);
    if (policy) setHeadlessRunPolicy(CID, policy);
    else clearHeadlessRunPolicy(CID);

    let seen: Record<string, unknown> | undefined;
    const stub = {
      name: "executePython",
      description: "stub",
      parameters: z.object({}).passthrough(),
      approval: { required: true },
      execute: async (i: unknown) => {
        seen = i as Record<string, unknown>;
        return { ok: true };
      },
    };
    const tool = toSDKTool(stub, "executePython");
    await (
      tool.execute as (i: unknown, o: { toolCallId: string }) => Promise<unknown>
    )(input, { toolCallId: "call-1" });
    return seen;
  }

  it("forces allow_network off in non-auto-approve headless runs", async () => {
    const seen = await runWithPolicy(
      { autoApprove: false },
      { code: "1", allow_network: true },
    );
    expect(seen).toMatchObject({ code: "1", allow_network: false });
  });

  it("leaves allow_network untouched in auto-approve headless runs", async () => {
    const seen = await runWithPolicy(
      { autoApprove: true },
      { code: "1", allow_network: true },
    );
    expect(seen).toMatchObject({ code: "1", allow_network: true });
  });

  it("leaves allow_network untouched in foreground (no headless policy) runs", async () => {
    const seen = await runWithPolicy(null, {
      code: "1",
      allow_network: true,
    });
    expect(seen).toMatchObject({ code: "1", allow_network: true });
  });
});
