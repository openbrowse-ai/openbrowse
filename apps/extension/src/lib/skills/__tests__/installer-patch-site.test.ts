import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { upsertSiteSkill, patchSiteSkill } from "../installer";
import { OPFS } from "../../vfs/opfs";
import { skillsDb } from "../skills-db";

// ---------------------------------------------------------------------------
// Minimal in-memory OPFS + IndexedDB shims for the Node test environment.
// `OPFS` talks to `navigator.storage.getDirectory()` and `skillsDb` talks to
// IndexedDB (via `idb`), neither of which exists under Vitest's `node` env.
// ---------------------------------------------------------------------------
class FakeFile {
  constructor(private data: string) {}
  text() {
    return Promise.resolve(this.data);
  }
}

class FakeWritable {
  private buf = "";
  constructor(private commit: (data: string) => void) {}
  write(chunk: string) {
    this.buf += typeof chunk === "string" ? chunk : String(chunk);
    return Promise.resolve();
  }
  close() {
    this.commit(this.buf);
    return Promise.resolve();
  }
}

class FakeFileHandle {
  readonly kind = "file" as const;
  constructor(private dir: FakeDirHandle, private fname: string) {}
  getFile() {
    return Promise.resolve(new FakeFile(this.dir._files.get(this.fname) ?? ""));
  }
  createWritable() {
    return Promise.resolve(
      new FakeWritable((data) => this.dir._files.set(this.fname, data)),
    );
  }
}

function notFound() {
  const e = new Error("NotFoundError");
  e.name = "NotFoundError";
  return e;
}

class FakeDirHandle {
  readonly kind = "directory" as const;
  _files = new Map<string, string>();
  _dirs = new Map<string, FakeDirHandle>();

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this._dirs.get(name);
    if (!d) {
      if (!opts?.create) throw notFound();
      d = new FakeDirHandle();
      this._dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this._files.has(name)) {
      if (!opts?.create) throw notFound();
      this._files.set(name, "");
    }
    return new FakeFileHandle(this, name);
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }) {
    const had = this._files.delete(name) || this._dirs.delete(name);
    if (!had) throw notFound();
  }

  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirHandle]> {
    for (const [name] of this._files)
      yield [name, new FakeFileHandle(this, name)];
    for (const [name, dir] of this._dirs) yield [name, dir];
  }
}

beforeAll(() => {
  const root = new FakeDirHandle();
  vi.stubGlobal("navigator", {
    ...(globalThis as { navigator?: object }).navigator,
    storage: { getDirectory: () => Promise.resolve(root) },
  });

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
