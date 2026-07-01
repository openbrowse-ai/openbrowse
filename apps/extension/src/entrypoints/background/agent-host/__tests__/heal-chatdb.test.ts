import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  healLastAssistantInChatDb,
  healSerializedParts,
} from "../heal-chatdb";
import type { SerializedUIPart } from "@/lib/agent/message-types";
import { TOOL_HEAL_INTERRUPT_TEXT } from "@/lib/agent/heal-pending-tools";
import { chatDb } from "@/lib/chat-db";

/**
 * SW-side heal that operates directly on chat-db's serialized parts.
 *
 * Use case: the SW agent host's run terminates (abort, error, success,
 * doesn't matter). The persister has been writing the in-flight
 * assistant message incrementally; if the run ends WHILE a tool part is
 * in a non-terminal state (`input-streaming`, `input-available`,
 * `approval-requested`, `approval-responded` without later completion),
 * chatDb is left with a stranded tool part. The renderer's
 * `healPendingTools` runs on the next user action, but if the user
 * never acts (reload, dropped session, the surface stays in viewer
 * mode), the chat-db row stays stranded — which:
 *
 *   - keeps the UI in "loading" state with the tool spinner
 *   - persists across reload because the heal lives in renderer state
 *
 * This SW-side heal closes that gap: when a run terminates, we call
 * `healSerializedParts` on the last persisted assistant message and
 * write it back if changes were made. The renderer's heal still runs
 * for the broader cases (chained multi-message healing, delegate
 * finalization, etc.); this is the per-run cleanup that the SW owns.
 *
 * Mirrors `healPendingTools` semantics. Difference: that function operates
 * on `AgentUIMessage[]` (parts in their AI SDK shape, can be `tool-X` or
 * `dynamic-tool`); this one operates on `SerializedUIPart[]` (the chat-db
 * encoding where ALL tool parts are normalized to `type: "dynamic-tool"`).
 */

function toolPart(state: string, extra: Partial<SerializedUIPart> = {}): SerializedUIPart {
  return {
    type: "dynamic-tool",
    toolName: "navigate",
    toolCallId: "toolu_1",
    state,
    ...extra,
  } as SerializedUIPart;
}

describe("healSerializedParts — terminal states stay untouched", () => {
  it("returns {changed: false} when all tool parts are terminal", () => {
    const parts: SerializedUIPart[] = [
      { type: "text", text: "Hello" },
      toolPart("output-available", { output: { ok: true } }),
      toolPart("output-error", { errorText: "boom" }),
      toolPart("output-denied"),
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(false);
    expect(result.parts).toBe(parts); // returns the same reference when no work
  });

  it("returns {changed: false} when there are no tool parts at all", () => {
    const parts: SerializedUIPart[] = [
      { type: "text", text: "Just a final message." },
      { type: "step-start" },
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(false);
  });
});

describe("healSerializedParts — heals non-terminal tool parts to output-error", () => {
  it("heals input-streaming to output-error with TOOL_HEAL_INTERRUPT_TEXT", () => {
    const parts: SerializedUIPart[] = [
      { type: "text", text: "Navigating..." },
      toolPart("input-streaming"),
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(true);
    const tp = result.parts[1] as { state: string; errorText: string };
    expect(tp.state).toBe("output-error");
    expect(tp.errorText).toBe(TOOL_HEAL_INTERRUPT_TEXT);
  });

  it("heals input-available to output-error", () => {
    const parts: SerializedUIPart[] = [
      toolPart("input-available", { input: { url: "https://example.com" } }),
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(true);
    expect(
      (result.parts[0] as { state: string }).state,
    ).toBe("output-error");
    // Input is preserved on heal.
    expect(
      (result.parts[0] as { input?: { url: string } }).input,
    ).toEqual({ url: "https://example.com" });
  });

  it("heals approval-requested to output-denied", () => {
    // Symmetric to renderer healPendingTools: a request-state approval
    // with no human response becomes a denial.
    const parts: SerializedUIPart[] = [
      toolPart("approval-requested", {
        approval: { id: "ap_1" },
      }),
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(true);
    const tp = result.parts[0] as {
      state: string;
      approval?: { approved?: boolean };
    };
    expect(tp.state).toBe("output-denied");
    expect(tp.approval?.approved).toBe(false);
  });

  it("heals approval-responded to output-error regardless of approval.approved", () => {
    // Same rationale as healPendingTools: by the time this heal runs,
    // the SDK can no longer resume the approved call — heal it to a
    // paired output-error so the next user message doesn't trip
    // "tool_use without tool_result".
    for (const approved of [true, false]) {
      const parts: SerializedUIPart[] = [
        toolPart("approval-responded", {
          approval: { id: "ap_1", approved },
        }),
      ];
      const result = healSerializedParts(parts);
      expect(result.changed).toBe(true);
      const expectedState = approved ? "output-error" : "output-denied";
      expect(
        (result.parts[0] as { state: string }).state,
      ).toBe(expectedState);
    }
  });

  it("heals approval-responded with missing approval to output-error (not denied)", () => {
    // Regression: pre-fix, `approval?.approved === true ? ... : "output-denied"`
    // conflated "user explicitly denied" with "interrupted before
    // responding". Missing/undefined approval is the latter case and
    // should heal to `output-error` with the interrupt text, mirroring
    // the approved-but-not-executed case.
    const parts: SerializedUIPart[] = [toolPart("approval-responded", {})];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(true);
    const out = result.parts[0] as {
      state: string;
      errorText?: string;
    };
    expect(out.state).toBe("output-error");
    expect(out.errorText).toBeDefined();
  });

  it("preserves non-tool parts (text, step-start, file) verbatim", () => {
    const text: SerializedUIPart = { type: "text", text: "Hello world" };
    const step: SerializedUIPart = { type: "step-start" };
    const parts: SerializedUIPart[] = [
      text,
      toolPart("input-streaming"),
      step,
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(true);
    expect(result.parts[0]).toBe(text); // same reference
    expect(result.parts[2]).toBe(step); // same reference
  });

  it("heals multiple stranded tools in one message", () => {
    const parts: SerializedUIPart[] = [
      toolPart("input-streaming", { toolCallId: "t1" }),
      { type: "text", text: "and another" },
      toolPart("approval-requested", {
        toolCallId: "t2",
        approval: { id: "ap_2" },
      }),
    ];
    const result = healSerializedParts(parts);
    expect(result.changed).toBe(true);
    expect((result.parts[0] as { state: string }).state).toBe("output-error");
    expect((result.parts[2] as { state: string }).state).toBe("output-denied");
  });
});

describe("healLastAssistantInChatDb — integration with chat-db", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  async function seedConversation(id: string): Promise<void> {
    await chatDb.createConversation({
      id,
      title: id,
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
    });
  }

  async function seedMessages(
    conversationId: string,
    msgs: Array<{
      id: string;
      role: "user" | "assistant";
      parts: SerializedUIPart[];
    }>,
  ): Promise<void> {
    await chatDb.saveMessages(
      msgs.map((m, i) => ({
        ...m,
        conversationId,
        content: "",
        createdAt: i,
      })),
    );
  }

  it("rewrites the last assistant message when it has a stranded tool", async () => {
    await seedConversation("c1");
    await seedMessages("c1", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Navigating..." },
          toolPart("input-streaming", { toolCallId: "t1" }),
        ],
      },
    ]);

    const result = await healLastAssistantInChatDb("c1");
    expect(result.healed).toBe(true);

    const after = await chatDb.getMessages("c1");
    expect(after).toHaveLength(2);
    const lastParts = after[1].parts;
    const tp = lastParts.find((p) => p.type === "dynamic-tool") as {
      state: string;
      errorText: string;
    };
    expect(tp.state).toBe("output-error");
    expect(tp.errorText).toBe(TOOL_HEAL_INTERRUPT_TEXT);
  });

  it("returns {healed: false} when the last assistant message is clean", async () => {
    await seedConversation("c1");
    await seedMessages("c1", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Done." },
          toolPart("output-available", {
            toolCallId: "t1",
            output: { ok: true },
          }),
        ],
      },
    ]);

    const result = await healLastAssistantInChatDb("c1");
    expect(result.healed).toBe(false);
  });

  it("returns {healed: false} when there are no assistant messages", async () => {
    await seedConversation("c1");
    await seedMessages("c1", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
    ]);

    const result = await healLastAssistantInChatDb("c1");
    expect(result.healed).toBe(false);
  });

  it("returns {healed: false} when the conversation has no messages at all", async () => {
    await seedConversation("c1");
    const result = await healLastAssistantInChatDb("c1");
    expect(result.healed).toBe(false);
  });

  it("only heals the LAST assistant message, leaves earlier ones untouched", async () => {
    // An older assistant message with a stranded tool stays as-is —
    // healing only the latest avoids retroactively rewriting history.
    await seedConversation("c1");
    await seedMessages("c1", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [toolPart("input-streaming", { toolCallId: "t1" })],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "again" }] },
      {
        id: "a2",
        role: "assistant",
        parts: [toolPart("input-available", { toolCallId: "t2" })],
      },
    ]);

    const result = await healLastAssistantInChatDb("c1");
    expect(result.healed).toBe(true);

    const after = await chatDb.getMessages("c1");
    // a1 stayed stranded (input-streaming preserved as-is).
    const a1Tool = (after[1].parts[0] as { state: string }).state;
    expect(a1Tool).toBe("input-streaming");
    // a2 got healed.
    const a2Tool = (after[3].parts[0] as { state: string }).state;
    expect(a2Tool).toBe("output-error");
  });

  it("is idempotent — second call after a successful heal is a no-op", async () => {
    await seedConversation("c1");
    await seedMessages("c1", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [toolPart("input-streaming", { toolCallId: "t1" })],
      },
    ]);
    const first = await healLastAssistantInChatDb("c1");
    expect(first.healed).toBe(true);
    const second = await healLastAssistantInChatDb("c1");
    expect(second.healed).toBe(false);
  });
});
