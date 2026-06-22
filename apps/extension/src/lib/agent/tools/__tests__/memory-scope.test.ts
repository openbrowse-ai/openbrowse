// src/lib/agent/tools/__tests__/memory-scope.test.ts
//
// Verifies the two-state scope contract for memory tools:
//
//   saveMemory:
//     - No active space, scope omitted or "user" → saves as global.
//     - No active space, scope "space" → error.
//     - Active space, scope omitted → error (must choose).
//     - Active space, scope "user" → saves as global.
//     - Active space, scope "space" → saves into the active space.
//     - The model never picks the spaceId; the session decides.
//
//   recallMemory:
//     - Always returns matches as an array.
//     - When the same title exists in both scopes, BOTH are returned —
//       globals are not hidden by a same-titled space-scoped memory.
//
//   updateMemory / deleteMemory:
//     - Single match → just works, scope preserved.
//     - Two matches without scope → error with `matches` listed.
//     - Two matches with scope → operates on the matching one only.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { saveMemoryTool } from "../save-memory";
import { recallMemoryTool } from "../recall-memory";
import { updateMemoryTool } from "../update-memory";
import { deleteMemoryTool } from "../delete-memory";
import { memoryDb } from "@/lib/memory-db";
import type { ToolContext } from "../../driver/tool-context";

function ctx(spaceId: string | null = null): ToolContext {
  return {
    driver: {} as ToolContext["driver"],
    session: { conversationId: "conv-test", spaceId },
  };
}

const baseSave = {
  description: "Test memory",
  type: "reference" as const,
  content: "Some content",
};

beforeEach(() => {
  indexedDB = new IDBFactory();
  memoryDb._resetForTests();
});

describe("saveMemory — two-state scope contract", () => {
  // No active space
  it("no active space, scope omitted → saves as global", async () => {
    const res = await saveMemoryTool.execute(
      { title: "user-name", ...baseSave },
      ctx(null),
    );
    expect(res).toMatchObject({ saved: true, scope: "user", spaceId: null });
  });

  it("no active space, scope:'user' → saves as global", async () => {
    const res = await saveMemoryTool.execute(
      { title: "user-name", scope: "user", ...baseSave },
      ctx(null),
    );
    expect(res).toMatchObject({ saved: true, scope: "user", spaceId: null });
  });

  it("no active space, scope:'space' → errors", async () => {
    const res = await saveMemoryTool.execute(
      { title: "x", scope: "space", ...baseSave },
      ctx(null),
    );
    expect(res).toEqual({
      saved: false,
      reason: expect.stringContaining("no space is currently active"),
    });
  });

  // Active space
  it("active space, scope omitted → errors (forces a choice)", async () => {
    const res = await saveMemoryTool.execute(
      { title: "x", ...baseSave },
      ctx("space-dev"),
    );
    expect(res).toEqual({
      saved: false,
      reason: expect.stringContaining("scope is required"),
    });
  });

  it("active space, scope:'user' → saves as global", async () => {
    const res = await saveMemoryTool.execute(
      { title: "real-name", scope: "user", ...baseSave },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({ saved: true, scope: "user", spaceId: null });
  });

  it("active space, scope:'space' → saves into the active space", async () => {
    const res = await saveMemoryTool.execute(
      { title: "repo-url", scope: "space", ...baseSave },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({
      saved: true,
      scope: "space",
      spaceId: "space-dev",
    });
  });

  // Source-of-truth
  it("ignores any model-supplied spaceId — the session decides", async () => {
    // The schema doesn't accept spaceId; zod silently strips unknown fields,
    // and the tool reads ctx.session.spaceId. Even if the model fabricates
    // a spaceId, it has no effect.
    const res = await saveMemoryTool.execute(
      // Cast through unknown so we can assert the runtime tolerates the
      // extra field without honoring it.
      {
        title: "x",
        scope: "space",
        ...baseSave,
        spaceId: "space-malicious",
      } as unknown as Parameters<typeof saveMemoryTool.execute>[0],
      ctx("space-dev"),
    );
    expect(res).toMatchObject({
      saved: true,
      scope: "space",
      spaceId: "space-dev",
    });
  });

  // Duplicate detection
  it("rejects a duplicate title within the same scope", async () => {
    await saveMemoryTool.execute(
      { title: "dup", scope: "space", ...baseSave },
      ctx("space-dev"),
    );
    const second = await saveMemoryTool.execute(
      { title: "dup", scope: "space", ...baseSave, content: "second body" },
      ctx("space-dev"),
    );
    expect(second).toMatchObject({ saved: false });
  });

  it("allows the same title across different scopes", async () => {
    const a = await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "user",
        ...baseSave,
        content: "global body",
      },
      ctx("space-dev"),
    );
    const b = await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "space",
        ...baseSave,
        content: "space body",
      },
      ctx("space-dev"),
    );
    expect(a).toMatchObject({ saved: true, scope: "user" });
    expect(b).toMatchObject({ saved: true, scope: "space" });
  });
});

describe("recallMemory — always returns matches array", () => {
  it("returns { found: false } when nothing matches", async () => {
    const res = await recallMemoryTool.execute(
      { title: "missing" },
      ctx("space-dev"),
    );
    expect(res).toEqual({ found: false });
  });

  it("returns one entry when only one match exists", async () => {
    await saveMemoryTool.execute(
      {
        title: "github-repo",
        scope: "space",
        ...baseSave,
        content: "openbrowse-ai/openbrowse",
      },
      ctx("space-dev"),
    );
    const res = await recallMemoryTool.execute(
      { title: "github-repo" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({
      found: true,
      matches: [
        {
          content: "openbrowse-ai/openbrowse",
          scope: "space",
        },
      ],
    });
    if (res.found) {
      expect(res.matches).toHaveLength(1);
    }
  });

  it("returns BOTH matches when the same title exists in user and space scope", async () => {
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "user",
        ...baseSave,
        content: "global body",
      },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "space",
        ...baseSave,
        content: "space body",
      },
      ctx("space-dev"),
    );

    const res = await recallMemoryTool.execute(
      { title: "shared" },
      ctx("space-dev"),
    );
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.matches).toHaveLength(2);
    // Both scopes should be represented; order is space-first, but assert
    // by membership rather than position to avoid coupling to that detail.
    const scopes = res.matches.map((m) => m.scope).sort();
    expect(scopes).toEqual(["space", "user"]);
    const contents = res.matches.map((m) => m.content).sort();
    expect(contents).toEqual(["global body", "space body"]);
  });

  it("a space-scoped same-titled memory does not hide the global one from another space", async () => {
    // Save a global "shared" while in space-dev, then save a space-scoped
    // "shared" in space-dev. From a different space, only the global one
    // is visible — the space-dev one is hidden by scope, not the global.
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "user",
        ...baseSave,
        content: "global body",
      },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "space",
        ...baseSave,
        content: "space-dev body",
      },
      ctx("space-dev"),
    );

    const res = await recallMemoryTool.execute(
      { title: "shared" },
      ctx("space-other"),
    );
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.matches).toEqual([
      expect.objectContaining({ scope: "user", content: "global body" }),
    ]);
  });
});

describe("updateMemory — disambiguation", () => {
  it("single match → updates without needing scope, preserves scope", async () => {
    await saveMemoryTool.execute(
      {
        title: "only-one",
        scope: "space",
        ...baseSave,
        content: "old body",
      },
      ctx("space-dev"),
    );
    const res = await updateMemoryTool.execute(
      { title: "only-one", content: "new body" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({ updated: true, scope: "space" });

    const stored = await memoryDb.findByTitleInExactScope(
      "only-one",
      "space-dev",
    );
    expect(stored?.content).toBe("new body");
  });

  it("zero matches → updated:false", async () => {
    const res = await updateMemoryTool.execute(
      { title: "nope", content: "x" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({
      updated: false,
      reason: expect.stringContaining("No memory found"),
    });
  });

  it("two matches without scope → updated:false with matches listed", async () => {
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "user",
        ...baseSave,
        description: "global desc",
      },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "space",
        ...baseSave,
        description: "space desc",
      },
      ctx("space-dev"),
    );

    const res = await updateMemoryTool.execute(
      { title: "shared", content: "rewritten" },
      ctx("space-dev"),
    );
    expect(res.updated).toBe(false);
    if (res.updated) return;
    expect(res.reason).toContain("Multiple memories");
    expect(res.matches).toHaveLength(2);
    const scopes = res.matches?.map((m) => m.scope).sort();
    expect(scopes).toEqual(["space", "user"]);
  });

  it("two matches with scope:'user' → only the global one is updated", async () => {
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "user",
        ...baseSave,
        content: "global body",
      },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "space",
        ...baseSave,
        content: "space body",
      },
      ctx("space-dev"),
    );

    const res = await updateMemoryTool.execute(
      { title: "shared", content: "rewritten global", scope: "user" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({ updated: true, scope: "user" });

    const userRow = await memoryDb.findByTitleInExactScope("shared", null);
    const spaceRow = await memoryDb.findByTitleInExactScope(
      "shared",
      "space-dev",
    );
    expect(userRow?.content).toBe("rewritten global");
    expect(spaceRow?.content).toBe("space body"); // untouched
  });

  it("two matches with scope:'space' → only the space-scoped one is updated", async () => {
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "user",
        ...baseSave,
        content: "global body",
      },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      {
        title: "shared",
        scope: "space",
        ...baseSave,
        content: "space body",
      },
      ctx("space-dev"),
    );

    const res = await updateMemoryTool.execute(
      { title: "shared", content: "rewritten space", scope: "space" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({ updated: true, scope: "space" });

    const userRow = await memoryDb.findByTitleInExactScope("shared", null);
    const spaceRow = await memoryDb.findByTitleInExactScope(
      "shared",
      "space-dev",
    );
    expect(userRow?.content).toBe("global body"); // untouched
    expect(spaceRow?.content).toBe("rewritten space");
  });
});

describe("deleteMemory — disambiguation", () => {
  it("single match → deletes without needing scope", async () => {
    await saveMemoryTool.execute(
      { title: "only-one", scope: "space", ...baseSave },
      ctx("space-dev"),
    );
    const res = await deleteMemoryTool.execute(
      { title: "only-one" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({ deleted: true, scope: "space" });

    const stored = await memoryDb.findByTitleInExactScope(
      "only-one",
      "space-dev",
    );
    expect(stored).toBeUndefined();
  });

  it("two matches without scope → deleted:false with matches listed", async () => {
    await saveMemoryTool.execute(
      { title: "shared", scope: "user", ...baseSave },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      { title: "shared", scope: "space", ...baseSave },
      ctx("space-dev"),
    );

    const res = await deleteMemoryTool.execute(
      { title: "shared" },
      ctx("space-dev"),
    );
    expect(res.deleted).toBe(false);
    if (res.deleted) return;
    expect(res.matches).toHaveLength(2);
  });

  it("two matches with scope:'user' → only the global one is deleted", async () => {
    await saveMemoryTool.execute(
      { title: "shared", scope: "user", ...baseSave },
      ctx("space-dev"),
    );
    await saveMemoryTool.execute(
      { title: "shared", scope: "space", ...baseSave },
      ctx("space-dev"),
    );

    const res = await deleteMemoryTool.execute(
      { title: "shared", scope: "user" },
      ctx("space-dev"),
    );
    expect(res).toMatchObject({ deleted: true, scope: "user" });

    const userRow = await memoryDb.findByTitleInExactScope("shared", null);
    const spaceRow = await memoryDb.findByTitleInExactScope(
      "shared",
      "space-dev",
    );
    expect(userRow).toBeUndefined();
    expect(spaceRow).toBeDefined(); // space-scoped one still there
  });
});
