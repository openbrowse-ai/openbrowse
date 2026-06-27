import { describe, it, expect, vi, beforeEach } from "vitest";

const opfs = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => undefined),
  readFile: vi.fn(async (_p: string) => "" as string),
  exists: vi.fn(async (_p: string) => false),
  readDir: vi.fn(async (_p: string) => [] as string[]),
  rm: vi.fn(async (_p: string, _o?: { recursive?: boolean }) => undefined),
  mkdir: vi.fn(async (_p: string) => undefined),
}));
vi.mock("@/lib/vfs/opfs", () => ({ OPFS: opfs }));

import { kvGet, kvSet, kvDelete, kvKeys } from "../kv";

beforeEach(() => {
  for (const fn of Object.values(opfs)) (fn as { mockReset: () => void }).mockReset();
  opfs.writeFileAtomic.mockResolvedValue(undefined);
  opfs.exists.mockResolvedValue(false);
  opfs.readDir.mockResolvedValue([]);
});

describe("kv", () => {
  it("rejects keys with .. or /", async () => {
    await expect(kvSet("a", "../x", "v")).rejects.toThrow();
    await expect(kvSet("a", "x/y", "v")).rejects.toThrow();
  });

  it("set then get round-trips JSON", async () => {
    let stored = "";
    opfs.writeFileAtomic.mockImplementation(async (_p, c) => { stored = c as string; });
    opfs.exists.mockResolvedValue(true);
    opfs.readFile.mockImplementation(async () => stored);
    await kvSet("art", "k", { hello: "world", n: 42 });
    expect(await kvGet("art", "k")).toEqual({ hello: "world", n: 42 });
  });

  it("get returns undefined for missing keys", async () => {
    opfs.exists.mockResolvedValue(false);
    expect(await kvGet("art", "missing")).toBeUndefined();
  });

  it("delete removes the key", async () => {
    opfs.exists.mockResolvedValue(true);
    await kvDelete("art", "k");
    expect(opfs.rm).toHaveBeenCalledWith("artifacts/art/kv/k.json");
  });

  it("keys lists keys without extension", async () => {
    opfs.exists.mockResolvedValue(true);
    opfs.readDir.mockResolvedValue(["foo.json", "bar.json"]);
    expect((await kvKeys("art")).sort()).toEqual(["bar", "foo"]);
  });
});
