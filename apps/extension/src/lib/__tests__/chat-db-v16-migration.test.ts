/**
 * Tests for the chat-db v16 upgrade hop, which sweeps every persisted
 * message's `parts` array and either recovers (stringified-JSON object,
 * rawInput object) or drops any tool part with a non-object `input`.
 *
 * Targets the specific Anthropic-only failure mode that motivated this
 * migration: the model (notably Opus) sometimes emits `input: ""` for a
 * no-arg MCP tool call, the persistence layer wrote it verbatim, and
 * every subsequent send 400'd with `tool_use.input: Input should be a
 * valid dictionary`. Gemini coerced the same shape silently, which is
 * why retrying on Gemini "just worked" — but the chat-db row stayed
 * broken on Anthropic until manually purged.
 *
 * Uses fake-indexeddb to drive a real IndexedDB upgrade lifecycle.
 */

import "fake-indexeddb/auto";
import { openDB } from "idb";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { chatDb } from "../chat-db";
import { tabRegistry } from "../agent/tab-registry";
import type { SerializedUIPart } from "../types";

/**
 * Seed a v15-shaped messages object store with a row whose `parts` carry
 * malformed tool inputs. The v15 hop's conversation columns aren't
 * relevant to v16, so we pass `ownedLtids: []` and skip handleState.
 */
async function seedV15MessageRow(row: {
  id: string;
  conversationId: string;
  parts: unknown[];
}): Promise<void> {
  const db = await openDB("openbrowse-chat", 15, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("conversations")) {
        const s = db.createObjectStore("conversations", { keyPath: "id" });
        s.createIndex("by-updated", "updatedAt");
        s.createIndex("by-space", "spaceId");
        s.createIndex("by-parent", "parentConversationId");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const m = db.createObjectStore("messages", { keyPath: "id" });
        m.createIndex("by-conversation", "conversationId");
      }
      if (!db.objectStoreNames.contains("scheduledTasks")) {
        const t = db.createObjectStore("scheduledTasks", { keyPath: "id" });
        t.createIndex("by-next-run", "nextRunAt");
      }
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record: any = {
    id: row.id,
    conversationId: row.conversationId,
    role: "assistant",
    content: "",
    parts: row.parts,
    createdAt: 0,
  };
  await db.put("messages", record);
  // Also seed the conversation so by-conversation queries work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conv: any = {
    id: row.conversationId,
    title: "t",
    spaceId: null,
    ownedGroupId: null,
    ownedLtids: [],
    parentConversationId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  await db.put("conversations", conv);
  db.close();
}

/** Read raw message past the typed wrapper. */
async function readMessageRaw(
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const db = await openDB("openbrowse-chat", 16);
  const v = await db.get("messages", id);
  db.close();
  return v as unknown as Record<string, unknown> | undefined;
}

describe("chatDb v16 migration: tool-input shape sweep", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    // Stub chrome (the v15 hop reads chrome.tabs.get).
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockRejectedValue(new Error("no tabs")) },
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops a tool part whose input is `\"\"` (the actual Opus bug shape)", async () => {
    await seedV15MessageRow({
      id: "m1",
      conversationId: "c1",
      parts: [
        { type: "text", text: "let me check" },
        {
          type: "dynamic-tool",
          toolName: "list-attribute-definitions",
          toolCallId: "toolu_1",
          state: "output-error",
          errorText: "boom",
          input: "", // ← malformed
        },
      ],
    });

    // Triggers the v15→v16 upgrade.
    await chatDb.getMessages("c1");

    const row = (await readMessageRaw("m1"))!;
    const parts = row.parts as SerializedUIPart[];
    // The text part survives; the malformed tool part is dropped.
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", text: "let me check" });
  });

  it("recovers a tool part whose input is a stringified JSON object", async () => {
    await seedV15MessageRow({
      id: "m2",
      conversationId: "c2",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "navigate",
          toolCallId: "toolu_2",
          state: "output-available",
          input: '{"url":"https://example.com"}',
          output: { ok: true },
        },
      ],
    });
    await chatDb.getMessages("c2");
    const row = (await readMessageRaw("m2"))!;
    const parts = row.parts as SerializedUIPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "dynamic-tool",
      input: { url: "https://example.com" },
    });
  });

  it("recovers a tool part using rawInput when input is a non-object", async () => {
    await seedV15MessageRow({
      id: "m3",
      conversationId: "c3",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "navigate",
          toolCallId: "toolu_3",
          state: "output-error",
          errorText: "boom",
          input: "",
          rawInput: { url: "https://example.com" },
        } as unknown as SerializedUIPart,
      ],
    });
    await chatDb.getMessages("c3");
    const row = (await readMessageRaw("m3"))!;
    const parts = row.parts as SerializedUIPart[];
    expect(parts).toHaveLength(1);
    expect((parts[0] as { input: unknown }).input).toEqual({
      url: "https://example.com",
    });
  });

  it("preserves a tool part with a valid object input verbatim", async () => {
    await seedV15MessageRow({
      id: "m4",
      conversationId: "c4",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "navigate",
          toolCallId: "toolu_4",
          state: "output-available",
          input: { url: "https://example.com" },
          output: { ok: true },
        },
      ],
    });
    await chatDb.getMessages("c4");
    const row = (await readMessageRaw("m4"))!;
    const parts = row.parts as SerializedUIPart[];
    expect(parts).toHaveLength(1);
    expect((parts[0] as { input: unknown }).input).toEqual({
      url: "https://example.com",
    });
  });

  it("preserves a tool part with intentionally absent input (terminal state)", async () => {
    await seedV15MessageRow({
      id: "m5",
      conversationId: "c5",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "x",
          toolCallId: "toolu_5",
          state: "output-error",
          errorText: "interrupted",
          // no `input` key at all — legitimate persisted shape
        } as unknown as SerializedUIPart,
      ],
    });
    await chatDb.getMessages("c5");
    const row = (await readMessageRaw("m5"))!;
    const parts = row.parts as SerializedUIPart[];
    expect(parts).toHaveLength(1);
    expect("input" in (parts[0] as object)).toBe(false);
  });

  it("drops only the malformed tool part, leaving siblings intact", async () => {
    await seedV15MessageRow({
      id: "m6",
      conversationId: "c6",
      parts: [
        { type: "text", text: "step 1" },
        {
          type: "dynamic-tool",
          toolName: "good",
          toolCallId: "toolu_good",
          state: "output-available",
          input: { ok: 1 },
          output: { ok: true },
        },
        {
          type: "dynamic-tool",
          toolName: "bad",
          toolCallId: "toolu_bad",
          state: "output-error",
          errorText: "boom",
          input: null,
        },
        { type: "text", text: "step 2" },
      ],
    });
    await chatDb.getMessages("c6");
    const row = (await readMessageRaw("m6"))!;
    const parts = row.parts as SerializedUIPart[];
    // text + good tool + text. The bad tool part is excised.
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text", text: "step 1" });
    expect((parts[1] as { toolCallId?: string }).toolCallId).toBe("toolu_good");
    expect(parts[2]).toMatchObject({ type: "text", text: "step 2" });
  });

  it("is idempotent — re-running on already-clean rows is a no-op", async () => {
    await seedV15MessageRow({
      id: "m7",
      conversationId: "c7",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "navigate",
          toolCallId: "toolu_7",
          state: "output-available",
          input: { url: "https://example.com" },
          output: { ok: true },
        },
      ],
    });
    await chatDb.getMessages("c7");
    const before = await readMessageRaw("m7");
    // Reset the in-memory cache; reopen to re-execute the upgrade chain.
    // (Re-opening at v16 should be a no-op since flags.needsV16Fixup
    // is only set when oldVersion < 16.)
    chatDb._resetForTests();
    await chatDb.getMessages("c7");
    const after = await readMessageRaw("m7");
    expect(after).toEqual(before);
  });

  it("logs a summary when at least one part was rewritten or dropped", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await seedV15MessageRow({
        id: "m8",
        conversationId: "c8",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "x",
            toolCallId: "toolu_8",
            state: "output-error",
            errorText: "boom",
            input: "",
          } as unknown as SerializedUIPart,
        ],
      });
      await chatDb.getMessages("c8");
      // Find an info call mentioning the v16 sweep.
      const calls = infoSpy.mock.calls.flat();
      const hasSummary = calls.some(
        (c) =>
          typeof c === "string" &&
          c.includes("v16") &&
          c.includes("dropped"),
      );
      expect(hasSummary).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
