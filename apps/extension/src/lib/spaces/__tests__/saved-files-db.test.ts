// src/lib/spaces/__tests__/saved-files-db.test.ts
//
// Covers the (saved | stale | unsaved) status logic and the cascade
// cleanup helpers. The save-flow integration tests (recording on save,
// overwrite-don't-duplicate) live in `save-to-space.test.ts`; these tests
// focus on the read/cleanup side of the API.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { savedFilesDb, sha256Hex } from "../saved-files-db";

beforeEach(() => {
  indexedDB = new IDBFactory();
  savedFilesDb._resetForTests();
});

async function seed(input: {
  conversationId: string;
  filePath: string;
  spaceId: string;
  spaceFilePath?: string;
  bytes: string;
  savedAt?: number;
}) {
  const bytes = new TextEncoder().encode(input.bytes);
  const sourceHashHex = await sha256Hex(bytes);
  return savedFilesDb.recordSave({
    conversationId: input.conversationId,
    filePath: input.filePath,
    spaceId: input.spaceId,
    spaceFilePath: input.spaceFilePath ?? input.filePath,
    savedAt: input.savedAt ?? Date.now(),
    sourceSize: bytes.byteLength,
    sourceHashHex,
  });
}

describe("savedFilesDb.getStatus", () => {
  it("unsaved when no record exists", async () => {
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      currentSourceSize: 5,
      currentSourceHashHex: "deadbeef",
    });
    expect(status).toEqual({ state: "unsaved" });
  });

  it("unsaved when no active space", async () => {
    await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      bytes: "hello",
    });
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: null,
      currentSourceSize: 5,
      currentSourceHashHex: await sha256Hex(new TextEncoder().encode("hello")),
    });
    expect(status).toEqual({ state: "unsaved" });
  });

  it("unsaved when record points at a different space", async () => {
    await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      bytes: "hello",
    });
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp2", // different space
      currentSourceSize: 5,
      currentSourceHashHex: await sha256Hex(new TextEncoder().encode("hello")),
    });
    expect(status).toEqual({ state: "unsaved" });
  });

  it("saved when record matches current size + hash", async () => {
    const bytes = new TextEncoder().encode("hello");
    const hash = await sha256Hex(bytes);
    await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      bytes: "hello",
    });
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      currentSourceSize: bytes.byteLength,
      currentSourceHashHex: hash,
    });
    expect(status.state).toBe("saved");
  });

  it("saved when current size + hash are not provided (skip staleness check)", async () => {
    await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      bytes: "hello",
    });
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      currentSourceSize: null,
      currentSourceHashHex: null,
    });
    expect(status.state).toBe("saved");
  });

  it("stale when source size differs", async () => {
    await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      bytes: "hello",
    });
    const newBytes = new TextEncoder().encode("hello world");
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      currentSourceSize: newBytes.byteLength,
      currentSourceHashHex: await sha256Hex(newBytes),
    });
    expect(status.state).toBe("stale");
  });

  it("stale when size matches but hash differs (same length, different content)", async () => {
    await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      bytes: "abcde", // 5 bytes
    });
    const newBytes = new TextEncoder().encode("vwxyz"); // also 5 bytes, different content
    const status = await savedFilesDb.getStatus({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      currentSourceSize: newBytes.byteLength,
      currentSourceHashHex: await sha256Hex(newBytes),
    });
    expect(status.state).toBe("stale");
  });
});

describe("savedFilesDb cleanup", () => {
  it("clearForConversation deletes all records for that conversation, leaves others intact", async () => {
    await seed({
      conversationId: "c1",
      filePath: "a.md",
      spaceId: "sp1",
      bytes: "a",
    });
    await seed({
      conversationId: "c1",
      filePath: "b.md",
      spaceId: "sp1",
      bytes: "b",
    });
    await seed({
      conversationId: "c2",
      filePath: "a.md",
      spaceId: "sp1",
      bytes: "a",
    });

    await savedFilesDb.clearForConversation("c1");

    expect(await savedFilesDb.get("c1", "a.md")).toBeUndefined();
    expect(await savedFilesDb.get("c1", "b.md")).toBeUndefined();
    expect(await savedFilesDb.get("c2", "a.md")).toBeDefined();
  });

  it("clearForSpace deletes all records targeting that space, leaves others intact", async () => {
    await seed({
      conversationId: "c1",
      filePath: "a.md",
      spaceId: "sp1",
      bytes: "a",
    });
    await seed({
      conversationId: "c1",
      filePath: "b.md",
      spaceId: "sp2",
      bytes: "b",
    });

    await savedFilesDb.clearForSpace("sp1");

    expect(await savedFilesDb.get("c1", "a.md")).toBeUndefined();
    expect(await savedFilesDb.get("c1", "b.md")).toBeDefined();
  });
});

describe("savedFilesDb.recordSave", () => {
  it("overwrites a prior record for the same (conversationId, filePath)", async () => {
    const first = await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      spaceFilePath: "notes.md",
      bytes: "v1",
      savedAt: 1000,
    });
    const second = await seed({
      conversationId: "c1",
      filePath: "notes.md",
      spaceId: "sp1",
      spaceFilePath: "notes.md",
      bytes: "v2",
      savedAt: 2000,
    });
    expect(first.key).toBe(second.key);
    const stored = await savedFilesDb.get("c1", "notes.md");
    expect(stored?.savedAt).toBe(2000);
    expect(stored?.sourceHashHex).toBe(second.sourceHashHex);
  });
});

describe("savedFilesDb.listForConversation", () => {
  it("returns every record for the conversation across spaces", async () => {
    await seed({
      conversationId: "c1",
      filePath: "a.md",
      spaceId: "sp1",
      bytes: "a",
    });
    await seed({
      conversationId: "c1",
      filePath: "b.md",
      spaceId: "sp2",
      bytes: "b",
    });
    await seed({
      conversationId: "c2",
      filePath: "x.md",
      spaceId: "sp1",
      bytes: "x",
    });

    const list = await savedFilesDb.listForConversation("c1");
    const filePaths = list.map((r) => r.filePath).sort();
    expect(filePaths).toEqual(["a.md", "b.md"]);
  });
});
