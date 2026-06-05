/**
 * Tests for the screenshot/image compaction pruners in `compaction.ts`,
 * focused on `keepOnlyLatestScreenshot` and its `allowlist` parameter.
 *
 * `keepOnlyLatestScreenshot` is the bench's primary context-bloat control:
 * because a bench trial has a single user turn, the user-turn-based pruner
 * never fires, so this "only keep the most recent page screenshot" pruner is
 * what prevents perception images from accumulating across steps. It also
 * accepts a caller-supplied allowlist so headless harnesses can prune images
 * produced under non-`screenshot` tool names (e.g. `viewPage`) WITHOUT the
 * public extension hardcoding experiment tool names.
 *
 * Critical invariants under test:
 *   - The DEFAULT allowlist is `["screenshot"]` (extension behavior unchanged).
 *   - A single screenshot is left untouched.
 *   - With N>1 screenshots, only the LAST keeps its image; earlier ones are
 *     replaced with the `{ removed }` placeholder.
 *   - A custom allowlist matches its tool names and NOT `screenshot`.
 *   - User-attached images / unrelated tool outputs are never stripped.
 *   - Already-stripped (no `imageDataUrl`) results are not counted.
 */

import { describe, expect, it } from "vitest";
import {
  keepOnlyLatestScreenshot,
  PAGE_SCREENSHOT_TOOLS,
  selectTailForManual,
  resolveCompactionModel,
  type PrunableMessage,
} from "./compaction";
import type { AgentUIMessage } from "./message-types";
import type { ProviderDefinition } from "@/registry/providers/types";

/** Build an assistant message wrapping a single tool-result part. */
function toolResultMsg(
  toolName: string,
  output: unknown,
  opts: { state?: string } = {},
): AgentUIMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName,
        toolCallId: `c-${Math.random().toString(36).slice(2)}`,
        state: opts.state ?? "output-available",
        input: {},
        output,
      } as AgentUIMessage["parts"][number],
    ],
  } as AgentUIMessage;
}

const img = (tag: string) => ({ imageDataUrl: `data:image/png;base64,${tag}` });

/** Pull every tool part's output across all messages, in order. */
function outputs(messages: AgentUIMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    for (const p of m.parts as any[]) {
      if (p.type === "dynamic-tool") out.push(p.output);
    }
  }
  return out;
}

function isStripped(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    "removed" in (output as Record<string, unknown>) &&
    !("imageDataUrl" in (output as Record<string, unknown>))
  );
}

describe("PAGE_SCREENSHOT_TOOLS default", () => {
  it("is exactly { screenshot } (extension default unchanged)", () => {
    expect([...PAGE_SCREENSHOT_TOOLS]).toEqual(["screenshot"]);
  });
});

describe("keepOnlyLatestScreenshot — default allowlist", () => {
  it("leaves a single screenshot untouched (returns same array reference)", () => {
    const messages = [toolResultMsg("screenshot", img("only"))];
    const result = keepOnlyLatestScreenshot(messages);
    expect(result).toBe(messages); // referential no-op
    expect(outputs(result)).toEqual([img("only")]);
  });

  it("keeps only the LAST screenshot when several are present", () => {
    const messages = [
      toolResultMsg("screenshot", img("first")),
      toolResultMsg("readPage", { text: "hello" }),
      toolResultMsg("screenshot", img("second")),
      toolResultMsg("screenshot", img("third")),
    ];
    const result = keepOnlyLatestScreenshot(messages);
    const out = outputs(result);

    // first + second stripped, third (latest) intact, readPage untouched.
    expect(isStripped(out[0])).toBe(true);
    expect(out[1]).toEqual({ text: "hello" });
    expect(isStripped(out[2])).toBe(true);
    expect(out[3]).toEqual(img("third"));
  });

  it("does not count already-stripped screenshots as live images", () => {
    // One live image + one previously-stripped placeholder → 1 live image → no-op.
    const messages = [
      toolResultMsg("screenshot", { removed: "[older screenshot stripped]" }),
      toolResultMsg("screenshot", img("live")),
    ];
    const result = keepOnlyLatestScreenshot(messages);
    expect(result).toBe(messages); // only 1 live image ⇒ nothing to strip
    expect(outputs(result)[1]).toEqual(img("live"));
  });

  it("ignores tool results that are not in the allowlist", () => {
    // Two `viewPage` images but default allowlist is screenshot-only ⇒ no-op.
    const messages = [
      toolResultMsg("viewPage", img("vp1")),
      toolResultMsg("viewPage", img("vp2")),
    ];
    const result = keepOnlyLatestScreenshot(messages);
    expect(result).toBe(messages);
    expect(outputs(result)).toEqual([img("vp1"), img("vp2")]);
  });

  it("ignores tool calls that are not yet output-available", () => {
    const messages = [
      toolResultMsg("screenshot", img("done1")),
      toolResultMsg("screenshot", img("pending"), { state: "input-available" }),
      toolResultMsg("screenshot", img("done2")),
    ];
    const result = keepOnlyLatestScreenshot(messages);
    const out = outputs(result);
    // Only the two output-available ones are candidates; the latest of those
    // (done2) is kept, done1 stripped, the pending one is left as-is.
    expect(isStripped(out[0])).toBe(true);
    expect(out[1]).toEqual(img("pending"));
    expect(out[2]).toEqual(img("done2"));
  });
});

describe("keepOnlyLatestScreenshot — custom allowlist", () => {
  it("prunes the allowlisted tool (viewPage) and not screenshot", () => {
    const allowlist = new Set(["viewPage"]);
    const messages = [
      toolResultMsg("viewPage", img("vp1")),
      toolResultMsg("screenshot", img("ss")), // NOT in custom allowlist
      toolResultMsg("viewPage", img("vp2")),
    ];
    const result = keepOnlyLatestScreenshot(messages, allowlist);
    const out = outputs(result);

    expect(isStripped(out[0])).toBe(true); // earlier viewPage stripped
    expect(out[1]).toEqual(img("ss")); // screenshot untouched (not allowlisted)
    expect(out[2]).toEqual(img("vp2")); // latest viewPage kept
  });

  it("never strips user-attached images (no tool name match)", () => {
    // A user message carrying an image part must be invisible to the pruner:
    // it has no `dynamic-tool`/`toolName`, so it can't match any allowlist.
    const userImageMsg = {
      id: "u1",
      role: "user",
      parts: [
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,USER" },
      ],
    } as unknown as AgentUIMessage;

    const messages = [
      userImageMsg,
      toolResultMsg("viewPage", img("vp1")),
      toolResultMsg("viewPage", img("vp2")),
    ];
    const result = keepOnlyLatestScreenshot(messages, new Set(["viewPage"]));
    const out = outputs(result); // only tool parts surface here

    // The user file part is preserved verbatim.
    expect((result[0].parts[0] as any).url).toBe("data:image/png;base64,USER");
    // viewPage pruning still works around it.
    expect(isStripped(out[0])).toBe(true);
    expect(out[1]).toEqual(img("vp2"));
  });
});

/**
 * `selectTailForManual` powers the user-typed `/compact` command. Unlike
 * `selectTail` (auto-compaction, which keeps the last 1-2 turns verbatim
 * so the agent can continue mid-task), a manual `/compact` means "continue
 * from the summary only" — so it summarizes the ENTIRE conversation and
 * keeps NO verbatim tail (`tailStartId === undefined`). The UI still shows
 * every original message; only the model view is replaced by the summary.
 *
 * It returns an empty head (→ caller toasts "too short") only when there
 * are fewer than two user turns, since there's nothing worth summarizing.
 */
describe("selectTailForManual", () => {
  function msg(
    id: string,
    role: PrunableMessage["role"],
    text: string,
  ): PrunableMessage {
    return { id, role, parts: [{ type: "text", text }], createdAt: 0 };
  }

  it("summarizes the whole conversation with no verbatim tail", () => {
    const messages: PrunableMessage[] = [
      msg("1", "user", "first question"),
      msg("2", "assistant", "first answer"),
      msg("3", "user", "second question"),
      msg("4", "assistant", "second answer"),
    ];
    const { headMessages, tailStartId } = selectTailForManual(messages);
    // Empty tail → the model sees only the summary; the entire chat is
    // the head to summarize.
    expect(tailStartId).toBeUndefined();
    expect(headMessages.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("ignores the token budget (small messages still compact fully)", () => {
    const messages: PrunableMessage[] = [
      msg("1", "user", "q1"),
      msg("2", "assistant", "a1"),
      msg("3", "user", "q2"),
      msg("4", "assistant", "a2"),
      msg("5", "user", "q3"),
      msg("6", "assistant", "a3"),
    ];
    const { headMessages, tailStartId } = selectTailForManual(messages);
    expect(tailStartId).toBeUndefined();
    expect(headMessages.map((m) => m.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("summarizes a trailing unanswered user message too (summary-only)", () => {
    const messages: PrunableMessage[] = [
      msg("1", "user", "q1"),
      msg("2", "assistant", "a1"),
      msg("3", "user", "q2 just sent"),
    ];
    const { headMessages, tailStartId } = selectTailForManual(messages);
    // Everything (including the trailing question) folds into the summary;
    // no verbatim tail.
    expect(tailStartId).toBeUndefined();
    expect(headMessages.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("returns an empty head when there is only one user turn", () => {
    const messages: PrunableMessage[] = [
      msg("1", "user", "only question"),
      msg("2", "assistant", "only answer"),
    ];
    const { headMessages } = selectTailForManual(messages);
    // Nothing worth summarizing → caller toasts "too short to compact".
    expect(headMessages.length).toBe(0);
  });

  it("returns an empty head for an empty conversation", () => {
    const { headMessages, tailStartId } = selectTailForManual([]);
    expect(headMessages.length).toBe(0);
    expect(tailStartId).toBeUndefined();
  });
});

/**
 * `resolveCompactionModel` maps a stored model key to a provider + bare
 * model id. Model keys are stored as composite "providerId:modelId"
 * strings (the format ModelPicker writes for both agentModel and
 * compactionModel), but `ProviderDefinition.createLanguageModel` and the
 * registry's model lists key off the BARE model id. Compaction previously
 * compared the composite key directly against bare ids, so the lookup
 * always failed → "no provider for compaction model" and silent
 * auto-compaction failures. These tests lock in the split + fallback.
 */
describe("resolveCompactionModel", () => {
  function provider(id: string, modelIds: string[]): ProviderDefinition {
    return {
      id,
      name: id,
      models: modelIds.map((mid) => ({ id: mid })),
    } as unknown as ProviderDefinition;
  }

  const providers = [
    provider("anthropic", ["claude-sonnet-4", "claude-opus-4"]),
    provider("openai", ["gpt-5"]),
    provider("openrouter", ["vendor:model"]),
  ];

  it("resolves a composite providerId:modelId key", () => {
    const r = resolveCompactionModel("anthropic:claude-sonnet-4", providers);
    expect(r?.provider.id).toBe("anthropic");
    expect(r?.modelId).toBe("claude-sonnet-4");
  });

  it("resolves a bare model id via fallback search", () => {
    const r = resolveCompactionModel("gpt-5", providers);
    expect(r?.provider.id).toBe("openai");
    expect(r?.modelId).toBe("gpt-5");
  });

  it("preserves colons in the model id portion", () => {
    // "openrouter:vendor:model" → provider openrouter, modelId "vendor:model"
    const r = resolveCompactionModel("openrouter:vendor:model", providers);
    expect(r?.provider.id).toBe("openrouter");
    expect(r?.modelId).toBe("vendor:model");
  });

  it("resolves the provider by prefix even if the model id is stale", () => {
    // Matches the canonical agentModel resolution: when a provider prefix
    // is present, the provider is selected by id alone.
    const r = resolveCompactionModel("anthropic:claude-removed", providers);
    expect(r?.provider.id).toBe("anthropic");
    expect(r?.modelId).toBe("claude-removed");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveCompactionModel("ghost-model", providers)).toBeUndefined();
    expect(
      resolveCompactionModel("unknown-provider:some-model", providers),
    ).toBeUndefined();
  });
});
