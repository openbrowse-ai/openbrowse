import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { upsertSiteSkill, patchSiteSkill } from "../installer";
import { OPFS } from "../../vfs/opfs";
import { skillsDb } from "../skills-db";
import { installFakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";

// ---------------------------------------------------------------------------
// In-memory IndexedDB shim for the Node test environment. `skillsDb` talks to
// IndexedDB (via `idb`), which Vitest's `node` env lacks; OPFS is covered by the
// shared `installFakeOpfs` helper.
// ---------------------------------------------------------------------------
beforeAll(() => {
  installFakeOpfs(vi);

  // In-memory replacement for the `skillsDb` store. The `idb` package needs a
  // real IndexedDB which the node env lacks; override the methods this test
  // (and `upsertSiteSkill`) touches.
  const store = new Map<string, unknown>();
  const db = skillsDb as unknown as Record<string, unknown>;
  db.save = (skill: { name: string }) => {
    store.set(skill.name, skill);
    return Promise.resolve();
  };
  db.get = (name: string) => Promise.resolve(store.get(name));
  db.delete = (name: string) => {
    store.delete(name);
    return Promise.resolve();
  };
});

describe("patchSiteSkill", () => {
  beforeEach(async () => {
    await OPFS.rm("skills/example.com", { recursive: true }).catch(() => {});
    await (skillsDb as { delete?: (name: string) => Promise<void> }).delete?.("example.com").catch(() => {});
  });

  it("creates a new skill when none exists", async () => {
    const s = await patchSiteSkill("example.com", {
      description: "Helpers for example.com.",
      body: "Notes.\n\n## Scripts\n- a.js: does A",
      upsertScripts: [{ path: "a.js", content: "return 1;" }],
    });
    expect(s.name).toBe("example.com");
    expect(s.fileIndex).toContain("a.js");
    expect(await OPFS.readFile("skills/example.com/a.js")).toBe("return 1;");
  });

  it("upserts one script without clobbering existing ones", async () => {
    await upsertSiteSkill("example.com", "d", "b", [
      { path: "a.js", content: "return 1;" },
      { path: "b.js", content: "return 2;" },
    ]);
    await patchSiteSkill("example.com", {
      upsertScripts: [{ path: "b.js", content: "return 22;" }],
    });
    expect(await OPFS.readFile("skills/example.com/a.js")).toBe("return 1;");
    expect(await OPFS.readFile("skills/example.com/b.js")).toBe("return 22;");
  });

  it("deletes a script and preserves the rest", async () => {
    await upsertSiteSkill("example.com", "d", "b", [
      { path: "a.js", content: "return 1;" },
      { path: "b.js", content: "return 2;" },
    ]);
    const s = await patchSiteSkill("example.com", { deleteScripts: ["a.js"] });
    expect(s.fileIndex).not.toContain("a.js");
    expect(s.fileIndex).toContain("b.js");
    expect(await OPFS.exists("skills/example.com/a.js")).toBe(false);
  });

  it("updates description/body while keeping scripts", async () => {
    await upsertSiteSkill("example.com", "old", "old body", [
      { path: "a.js", content: "return 1;" },
    ]);
    const s = await patchSiteSkill("example.com", {
      description: "new desc",
      body: "new body",
    });
    expect(s.description).toBe("new desc");
    expect(s.fileIndex).toContain("a.js");
    const md = await OPFS.readFile("skills/example.com/SKILL.md");
    expect(md).toContain("description: new desc");
    expect(md).toContain("new body");
  });
});
