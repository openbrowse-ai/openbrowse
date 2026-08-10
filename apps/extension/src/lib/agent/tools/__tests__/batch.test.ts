import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
    HEADLESS_APPROVAL_DROP_TOOLS,
    HEADLESS_SCHEDULED_DROP_TOOLS,
} from "../../agent-transport";
import type { ToolContext } from "../../driver";
import type { BrowserTool } from "../../types";
import {
    BATCH_CONCURRENCY,
    BATCHABLE,
    buildBatchableRegistry,
    createBatchTool,
    MAX_INVOCATIONS,
} from "../batch";
import {
    normalizeInvocationArguments,
    readBatchDescription,
    readBatchInvocations,
    readBatchResults,
    readInBandError,
} from "../batch-args";
import { screenshotTool } from "../screenshot";

type AnyTool = BrowserTool<any, unknown>;

/** Minimal ToolContext — batchable tools are stubbed in these tests. */
function fakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    driver: {} as never,
    toolCallId: "call-1",
    ...overrides,
  };
}

function stubTool(
  name: string,
  execute: AnyTool["execute"],
  parameters: AnyTool["parameters"] = z.object({}),
): AnyTool {
  return { name, description: `stub ${name}`, parameters, execute };
}

/**
 * Run `count` invocations of a tool that reports how many were in flight
 * at once, so the concurrency tests can assert the observed peak.
 */
async function runTracked(count: number) {
  let inFlight = 0;
  let inFlightPeak = 0;
  const registry = {
    slow: stubTool("slow", async () => {
      inFlight += 1;
      inFlightPeak = Math.max(inFlightPeak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return "done";
    }),
  };
  const out = await runBatch(
    registry,
    Array.from({ length: count }, () => ({ name: "slow" })),
  );
  return { inFlightPeak, out };
}

async function runBatch(
  registry: Record<string, AnyTool>,
  invocations: { name: string; arguments?: unknown }[],
  ctx: ToolContext = fakeCtx(),
) {
  const tool = createBatchTool(registry);
  return tool.execute(
    { description: "Reading test fixtures", invocations },
    ctx,
  );
}

describe("batchable registry invariants", () => {
  /**
   * The load-bearing guard. `batch` calls `tool.execute()` directly and
   * therefore bypasses `toSDKTool`'s approval gating entirely, so an
   * approval-gated tool in this registry is an approval BYPASS, not a
   * convenience. If this fails, remove the tool from the registry —
   * don't relax the assertion.
   */
  it("contains no approval-gated tool", () => {
    const gated = Object.entries(buildBatchableRegistry())
      .filter(([, tool]) => tool.approval?.required === true)
      .map(([name]) => name);
    expect(gated).toEqual([]);
  });

  /**
   * Compaction identifies strippable images by `part.toolName`
   * (`STRIPPABLE_IMAGE_TOOLS` / `PAGE_SCREENSHOT_TOOLS` in
   * `../../compaction.ts`). A screenshot nested under `toolName: "batch"`
   * would never be stripped, so context would grow without bound.
   */
  it("excludes screenshot so compaction can still strip images", () => {
    const registry = buildBatchableRegistry();
    expect(registry.screenshot).toBeUndefined();
    expect(BATCHABLE).not.toContain("screenshot");
    // Sanity check that the excluded tool is the one we think it is.
    expect(screenshotTool.name).toBe("screenshot");
  });

  /**
   * Headless (scheduled / MCP) runs drop tools that need a human in the
   * loop, and `createBrowserToolSet` builds `batch` before that filter
   * runs — so a batchable tool on the drop list would be reachable
   * through `batch` in exactly the runs it was removed from. Every entry
   * below is either approval-gated (covered by the assertion above) or
   * explicitly asserted here.
   */
  it("excludes tools that headless runs drop", () => {
    // Reads the lists from `agent-transport` rather than restating them,
    // so adding a tool to the headless filter automatically extends this
    // invariant. `list_scheduled_tasks` is the case that motivates it: it
    // is read-only and looks like a fine batch candidate, but a scheduled
    // run drops it to prevent recursion.
    const dropped = [
      ...HEADLESS_APPROVAL_DROP_TOOLS,
      ...HEADLESS_SCHEDULED_DROP_TOOLS,
    ];
    expect(dropped.length).toBeGreaterThan(0);
    for (const name of dropped) {
      expect(BATCHABLE).not.toContain(name);
    }
  });

  it("excludes every mutating tool", () => {
    for (const name of [
      "clickElement",
      "typeInElement",
      "pressKey",
      "navigate",
      "scrollPage",
      "selectTab",
      "closeTabs",
      "Write",
      "Edit",
      "Delete",
      // `Move` ships ungated (no `approval` config), so the
      // approval-free assertion above would NOT catch it. Memory is a
      // file tree post-v2, which makes Move a plausible-looking but
      // mutating candidate.
      "Move",
      "executeCode",
      "executeOnPage",
      "executePython",
      "create_artifact",
      "update_artifact",
      "delete_artifact",
      "delegate",
      "batch",
    ]) {
      expect(BATCHABLE).not.toContain(name);
    }
  });

  it("keys the registry by the names the model uses directly", () => {
    const registry = buildBatchableRegistry();
    for (const [key, tool] of Object.entries(registry)) {
      expect(tool.name).toBe(key);
    }
  });
});

describe("batch tool description", () => {
  it("lists exactly the registry it was built over", () => {
    const tool = createBatchTool({
      snapshot: stubTool("snapshot", async () => ({})),
      readPage: stubTool("readPage", async () => ({})),
    });
    expect(tool.description).toContain("Batchable tools: snapshot, readPage.");
    expect(tool.description).not.toContain("Batchable tools: snapshot, readPage, ");
  });
});

describe("batch input schema", () => {
  const tool = createBatchTool();

  it("rejects a single invocation (call it directly instead)", () => {
    expect(
      tool.parameters.safeParse({
        description: "Listing tabs",
        invocations: [{ name: "listTabs" }],
      }).success,
    ).toBe(false);
  });

  it(`rejects more than ${MAX_INVOCATIONS} invocations`, () => {
    const invocations = Array.from({ length: MAX_INVOCATIONS + 1 }, () => ({
      name: "listTabs",
    }));
    expect(
      tool.parameters.safeParse({ description: "Listing tabs", invocations })
        .success,
    ).toBe(false);
  });

  it("accepts invocations with omitted arguments", () => {
    expect(
      tool.parameters.safeParse({
        description: "Checking open tabs",
        invocations: [{ name: "listTabs" }, { name: "list_artifacts" }],
      }).success,
    ).toBe(true);
  });

  it("requires a non-empty description for the collapsed row", () => {
    const invocations = [{ name: "listTabs" }, { name: "list_artifacts" }];
    expect(tool.parameters.safeParse({ invocations }).success).toBe(false);
    expect(
      tool.parameters.safeParse({ description: "", invocations }).success,
    ).toBe(false);
  });
});

describe("batch execution", () => {
  it("returns results in input order regardless of completion order", async () => {
    const registry = {
      slow: stubTool("slow", async () => {
        await new Promise((r) => setTimeout(r, 20));
        return "slow-done";
      }),
      fast: stubTool("fast", async () => "fast-done"),
    };
    const out = await runBatch(registry, [
      { name: "slow" },
      { name: "fast" },
      { name: "slow" },
    ]);
    expect(out.results.map((r) => r.name)).toEqual(["slow", "fast", "slow"]);
    expect(out.results.map((r) => r.output)).toEqual([
      "slow-done",
      "fast-done",
      "slow-done",
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
  });

  it("errors only the offending invocation for a non-batchable tool", async () => {
    const ok = vi.fn(async () => "read");
    const out = await runBatch({ readPage: stubTool("readPage", ok) }, [
      { name: "clickElement", arguments: { tab: "t1", target: "@e1" } },
      { name: "readPage", arguments: {} },
    ]);
    expect(out.results[0]).toMatchObject({
      name: "clickElement",
      ok: false,
    });
    expect(out.results[0].error).toContain("cannot be batched");
    expect(out.results[0].error).toContain("Call \"clickElement\" directly");
    expect(out.results[1]).toMatchObject({ name: "readPage", ok: true });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not reach inherited Object properties as tools", async () => {
    const out = await runBatch({ readPage: stubTool("readPage", async () => 1) }, [
      { name: "toString" },
      { name: "constructor" },
    ]);
    expect(out.results.every((r) => !r.ok)).toBe(true);
    expect(out.results[0].error).toContain("cannot be batched");
  });

  it("reports a schema violation against the child tool's own schema", async () => {
    const registry = {
      readPage: stubTool(
        "readPage",
        async () => "never",
        z.object({ tab: z.string() }),
      ),
      listTabs: stubTool("listTabs", async () => []),
    };
    const out = await runBatch(registry, [
      { name: "readPage", arguments: {} },
      { name: "listTabs" },
    ]);
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toContain('Invalid arguments for "readPage"');
    expect(out.results[0].error).toContain("tab");
    expect(out.results[1].ok).toBe(true);
  });

  it("isolates a throwing tool from its siblings", async () => {
    const registry = {
      boom: stubTool("boom", async () => {
        throw new Error("page detached");
      }),
      fine: stubTool("fine", async () => "ok"),
    };
    const out = await runBatch(registry, [{ name: "boom" }, { name: "fine" }]);
    expect(out.results[0]).toEqual({
      name: "boom",
      ok: false,
      error: "page detached",
    });
    expect(out.results[1]).toEqual({ name: "fine", ok: true, output: "ok" });
  });

  it("accepts arguments sent as a JSON string (Claude hedging on z.any)", async () => {
    const seen: unknown[] = [];
    const registry = {
      readPage: stubTool(
        "readPage",
        async (input) => {
          seen.push(input);
          return "read";
        },
        z.object({ tab: z.string() }),
      ),
    };
    const out = await runBatch(registry, [
      { name: "readPage", arguments: '{"tab":"t1"}' },
      { name: "readPage", arguments: { tab: "t2" } },
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(seen).toEqual([{ tab: "t1" }, { tab: "t2" }]);
  });

  it("runs a full batch as a single wave", async () => {
    // BATCH_CONCURRENCY === MAX_INVOCATIONS, so nothing a real call can
    // request gets throttled — the whole point of the batch is to spend
    // one round-trip, not to re-serialize the work behind a limiter.
    const { inFlightPeak, out } = await runTracked(MAX_INVOCATIONS);
    expect(out.results).toHaveLength(MAX_INVOCATIONS);
    expect(inFlightPeak).toBe(MAX_INVOCATIONS);
  });

  it("still limits if the ceiling is ever lowered", async () => {
    // Guards the limiter itself, which the test above cannot: with the
    // constants equal it would pass even against a no-op scheduler.
    // `execute` is called directly here, bypassing the input schema, to
    // request more than a real call could.
    const { inFlightPeak, out } = await runTracked(BATCH_CONCURRENCY + 3);
    expect(out.results).toHaveLength(BATCH_CONCURRENCY + 3);
    expect(inFlightPeak).toBe(BATCH_CONCURRENCY);
  });

  it("sub-scopes toolCallId per invocation so per-call stores don't collide", async () => {
    const ids: (string | undefined)[] = [];
    const registry = {
      probe: stubTool("probe", async (_input, ctx) => {
        ids.push(ctx.toolCallId);
        return null;
      }),
    };
    await runBatch(registry, [{ name: "probe" }, { name: "probe" }], fakeCtx());
    expect(ids).toEqual(["call-1:0", "call-1:1"]);
  });

  it("skips everything when the run is already cancelled", async () => {
    const execute = vi.fn(async () => "never");
    const out = await runBatch(
      { probe: stubTool("probe", execute) },
      [{ name: "probe" }, { name: "probe" }],
      fakeCtx({ signal: AbortSignal.abort() }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.error?.startsWith("Skipped:"))).toBe(
      true,
    );
  });

  it("reports invocations not yet started at cancel time as skipped", async () => {
    const controller = new AbortController();
    let started = 0;
    const registry = {
      probe: stubTool("probe", async () => {
        started += 1;
        // Cancel from inside the first invocation.
        controller.abort();
        await new Promise((r) => setTimeout(r, 5));
        return "done";
      }),
    };
    const total = MAX_INVOCATIONS;
    const out = await runBatch(
      registry,
      Array.from({ length: total }, () => ({ name: "probe" })),
      fakeCtx({ signal: controller.signal }),
    );

    // At least one invocation was dispatched before the abort landed, and
    // not all of them were.
    expect(started).toBeGreaterThanOrEqual(1);
    expect(started).toBeLessThan(total);
    // Everything queued behind it is REPORTED as skipped rather than
    // dropped, so the model still sees one result per invocation and the
    // completed work is not thrown away.
    expect(out.results).toHaveLength(total);
    expect(out.results.filter((r) => r.ok)).toHaveLength(started);
    expect(
      out.results.filter((r) => r.error?.startsWith("Skipped:")),
    ).toHaveLength(total - started);
  });
});

describe("normalizeInvocationArguments", () => {
  it("treats null, undefined, and empty string as no arguments", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(normalizeInvocationArguments(raw)).toEqual({
        ok: true,
        value: {},
      });
    }
  });

  it("passes an object through verbatim", () => {
    const value = { tab: "t1", mode: "viewport" };
    expect(normalizeInvocationArguments(value)).toEqual({ ok: true, value });
  });

  it("parses a JSON-encoded object", () => {
    expect(normalizeInvocationArguments('{"tab":"t1"}')).toEqual({
      ok: true,
      value: { tab: "t1" },
    });
  });

  it("rejects unparseable strings, arrays, and primitives", () => {
    for (const raw of ["{not json", "[1,2]", '"str"', [1, 2], 42, true]) {
      expect(normalizeInvocationArguments(raw).ok).toBe(false);
    }
  });
});

describe("in-band tool errors", () => {
  it("counts a tool that reports failure in its payload as failed", async () => {
    // `webSearch` returns `{ results: [], error }` rather than throwing.
    // Counting it as a success produced a green check above red error
    // text in the UI.
    const registry = {
      webSearch: stubTool("webSearch", async () => ({
        results: [],
        error: "Failed to fetch",
      })),
      readPage: stubTool("readPage", async () => "text"),
    };
    const out = await runBatch(registry, [
      { name: "webSearch" },
      { name: "readPage" },
    ]);
    expect(out.results[0]).toMatchObject({
      name: "webSearch",
      ok: false,
      error: "Failed to fetch",
    });
    // The payload survives so the model and the child renderer keep it.
    expect(out.results[0].output).toEqual({
      results: [],
      error: "Failed to fetch",
    });
    expect(out.results[1].ok).toBe(true);
  });

  it("leaves successful payloads alone", async () => {
    const registry = {
      webSearch: stubTool("webSearch", async () => ({
        results: [{ title: "hit" }],
      })),
      found: stubTool("found", async () => ({ found: false })),
      empty: stubTool("empty", async () => ({ error: "   " })),
    };
    const out = await runBatch(registry, [
      { name: "webSearch" },
      { name: "found" },
      { name: "empty" },
    ]);
    // `{ found: false }` is a legitimate answer, not a failure, and a
    // blank `error` is not a message.
    expect(out.results.map((r) => r.ok)).toEqual([true, true, true]);
  });
});

describe("readInBandError", () => {
  it("detects a non-empty string error property", () => {
    expect(readInBandError({ error: "boom" })).toBe("boom");
    expect(readInBandError({ results: [], error: " timed out " })).toBe(
      "timed out",
    );
  });

  it("ignores everything else", () => {
    for (const output of [
      null,
      undefined,
      "Error: file not found",
      ["error"],
      42,
      {},
      { error: "" },
      { error: "   " },
      { error: 500 },
      { found: false },
    ]) {
      expect(readInBandError(output)).toBeNull();
    }
  });
});

describe("readBatchDescription", () => {
  it("reads a description, trimming the ellipsis the UI adds itself", () => {
    expect(
      readBatchDescription({ description: "Comparing pricing pages" }),
    ).toBe("Comparing pricing pages");
    expect(
      readBatchDescription({ description: "  Checking release notes...  " }),
    ).toBe("Checking release notes");
    expect(readBatchDescription({ description: "Reading reviews\u2026" })).toBe(
      "Reading reviews",
    );
  });

  it("returns null for absent, blank, or non-string descriptions", () => {
    for (const input of [
      undefined,
      {},
      { description: "" },
      { description: "   " },
      { description: 42 },
      { description: null },
    ]) {
      expect(readBatchDescription(input)).toBeNull();
    }
  });
});

describe("batch-args readers", () => {
  it("reads invocations, dropping entries without a string name", () => {
    expect(
      readBatchInvocations({
        invocations: [
          { name: "readPage", arguments: { tab: "t1" } },
          { name: "" },
          { arguments: { tab: "t2" } },
          "junk",
        ],
      }),
    ).toEqual([{ name: "readPage", arguments: { tab: "t1" } }]);
  });

  it("returns an empty array for partial or malformed inputs", () => {
    expect(readBatchInvocations(undefined)).toEqual([]);
    expect(readBatchInvocations({})).toEqual([]);
    expect(readBatchInvocations({ invocations: "nope" })).toEqual([]);
  });

  it("returns an empty array for toSDKTool's error-shaped output", () => {
    expect(readBatchResults({ error: "boom" })).toEqual([]);
    expect(readBatchResults(undefined)).toEqual([]);
  });

  it("reads well-formed results", () => {
    expect(
      readBatchResults({
        results: [{ name: "readPage", ok: true, output: "hi" }, { ok: false }],
      }),
    ).toEqual([{ name: "readPage", ok: true, output: "hi" }]);
  });
});
