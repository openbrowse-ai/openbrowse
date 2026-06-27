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

import { saveArtifact, loadArtifact, listArtifacts, deleteArtifact } from "../registry";
import { artifactsEvents } from "../events";
import type { ArtifactManifest } from "../manifest";

const manifest: ArtifactManifest = {
  v: 1,
  id: "linear-triage",
  title: "Linear Triage",
  tools: [{ name: "mcp.linear.search_issues", mode: "read" }],
};

beforeEach(() => {
  for (const fn of Object.values(opfs)) (fn as { mockReset: () => void }).mockReset();
  opfs.writeFileAtomic.mockResolvedValue(undefined);
  opfs.exists.mockResolvedValue(false);
  opfs.readDir.mockResolvedValue([]);
});

describe("saveArtifact", () => {
  it("inlines the manifest meta tag and writes html + sidecar atomically", async () => {
    const html = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    await saveArtifact({ manifest, html, sourceConversationId: "c1" });

    expect(opfs.writeFileAtomic).toHaveBeenCalledTimes(2);
    const [htmlCall, metaCall] = opfs.writeFileAtomic.mock.calls;
    expect(htmlCall[0]).toBe("artifacts/linear-triage.html");
    expect(htmlCall[1]).toContain('<meta name="openbrowse:artifact"');
    expect(htmlCall[1]).toContain('"id":"linear-triage"');
    expect(metaCall[0]).toBe("artifacts/linear-triage.meta.json");
    const sidecar = JSON.parse(metaCall[1]);
    expect(sidecar.id).toBe("linear-triage");
    expect(sidecar.sourceConversationId).toBe("c1");
    expect(sidecar.manifestVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(sidecar.approvedWrites).toEqual([]);
    expect(sidecar.approvedNetwork).toEqual([]);
  });

  it("strips an existing openbrowse:artifact meta tag before re-inlining", async () => {
    const html = '<!doctype html><meta name="openbrowse:artifact" content=\'{"v":1}\'><html></html>';
    await saveArtifact({ manifest, html, sourceConversationId: null });
    const written = opfs.writeFileAtomic.mock.calls[0][1] as string;
    expect((written.match(/openbrowse:artifact/g) ?? []).length).toBe(1);
  });

  it("round-trips manifests containing < and > in title/description", async () => {
    // Capture what saveArtifact writes.
    let writtenHtml = "";
    opfs.writeFileAtomic.mockImplementation(async (p: string, c: string) => {
      if (p.endsWith(".html")) writtenHtml = c;
    });
    opfs.exists.mockImplementation(async (p: string) => p.endsWith(".html") || p.endsWith(".meta.json"));
    opfs.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith(".html")) return writtenHtml;
      return JSON.stringify({
        id: "art-roundtrip", createdAt: "t", updatedAt: "t",
        approvedWrites: [], approvedNetwork: [], manifestVersion: "v",
      });
    });

    const m: ArtifactManifest = {
      v: 1,
      id: "art-roundtrip",
      title: "Step 1 > Step 2",
      description: "Open <details> here",
      tools: [{ name: "mcp.linear.search_issues", mode: "read" }],
    };
    await saveArtifact({ manifest: m, html: "<html><body></body></html>", sourceConversationId: null });

    // Now load it back through the same path the host would.
    const reloaded = await loadArtifact("art-roundtrip");
    expect(reloaded).not.toBeNull();
    expect(reloaded?.manifest.title).toBe("Step 1 > Step 2");
    expect(reloaded?.manifest.description).toBe("Open <details> here");
  });

  it("resets approvals and installedAt when manifestVersion changes", async () => {
    // Prior sidecar with a stale manifestVersion and recorded approvals.
    opfs.exists.mockImplementation(async (p: string) => p.endsWith(".meta.json"));
    opfs.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith(".meta.json")) {
        return JSON.stringify({
          id: "art",
          createdAt: "t-old",
          updatedAt: "t-old",
          installedAt: "t-installed",
          approvedWrites: ["mcp.linear.update_issue"],
          approvedNetwork: ["api.example.com"],
          manifestVersion: "stale-version-sha",
        });
      }
      return "";
    });

    await saveArtifact({
      manifest: {
        v: 1, id: "art", title: "X",
        // Different tools => different canonical => different manifestVersion
        tools: [{ name: "mcp.linear.search_issues", mode: "read" }],
      },
      html: "<html></html>",
      sourceConversationId: null,
    });

    const metaCall = opfs.writeFileAtomic.mock.calls.find(([p]) => p.endsWith(".meta.json"));
    expect(metaCall).toBeDefined();
    const sidecar = JSON.parse(metaCall![1] as string);
    expect(sidecar.approvedWrites).toEqual([]);
    expect(sidecar.approvedNetwork).toEqual([]);
    expect(sidecar.installedAt).toBeUndefined();
    expect(sidecar.createdAt).toBe("t-old"); // preserved
  });
});

describe("loadArtifact", () => {
  it("parses manifest from the inlined meta tag", async () => {
    const html = '<!doctype html><meta name="openbrowse:artifact" content=\'{"v":1,"id":"art","title":"X","tools":[]}\'><html></html>';
    opfs.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    opfs.readFile.mockResolvedValueOnce(html).mockResolvedValueOnce(JSON.stringify({
      id: "art", createdAt: "t", updatedAt: "t", approvedWrites: [], approvedNetwork: [], manifestVersion: "v",
    }));
    const result = await loadArtifact("art");
    expect(result?.manifest.id).toBe("art");
    expect(result?.html).toBe(html);
    expect(result?.sidecar.manifestVersion).toBe("v");
  });

  it("returns null when missing", async () => {
    opfs.exists.mockResolvedValueOnce(false);
    expect(await loadArtifact("nope")).toBeNull();
  });

  it("parses manifest when other attributes precede name (order-agnostic)", async () => {
    const html =
      '<!doctype html><meta http-equiv="x" name="openbrowse:artifact" content=\'{"v":1,"id":"art","title":"X","tools":[]}\'><html></html>';
    opfs.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    opfs.readFile.mockResolvedValueOnce(html).mockResolvedValueOnce(JSON.stringify({
      id: "art", createdAt: "t", updatedAt: "t", approvedWrites: [], approvedNetwork: [], manifestVersion: "v",
    }));
    const result = await loadArtifact("art");
    expect(result?.manifest.id).toBe("art");
  });
});

describe("listArtifacts", () => {
  it("returns metadata for every .html in /artifacts/", async () => {
    opfs.readDir.mockResolvedValueOnce(["art-a.html", "art-a.meta.json", "art-a/", "art-b.html", "art-b.meta.json"]);
    opfs.exists.mockResolvedValue(true);
    opfs.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith(".html")) {
        const id = p.match(/artifacts\/(.+)\.html/)?.[1] ?? "";
        return `<meta name="openbrowse:artifact" content='${JSON.stringify({ v: 1, id, title: id.toUpperCase(), tools: [] })}'>`;
      }
      return JSON.stringify({ id: "", createdAt: "t", updatedAt: "t", approvedWrites: [], approvedNetwork: [], manifestVersion: "v" });
    });
    const list = await listArtifacts();
    expect(list.map((x) => x.manifest.id).sort()).toEqual(["art-a", "art-b"]);
  });
});

describe("deleteArtifact", () => {
  it("removes html, meta, and the per-artifact directory", async () => {
    opfs.exists.mockResolvedValue(true);
    await deleteArtifact("linear-triage");
    expect(opfs.rm).toHaveBeenCalledWith("artifacts/linear-triage.html");
    expect(opfs.rm).toHaveBeenCalledWith("artifacts/linear-triage.meta.json");
    expect(opfs.rm).toHaveBeenCalledWith("artifacts/linear-triage", { recursive: true });
  });
});

import { renameArtifact, setFavorite, setArtifactIcon } from "../registry";

describe("renameArtifact", () => {
  it("updates the title of an existing artifact and saves it", async () => {
    const html = '<!doctype html><meta name="openbrowse:artifact" content=\'{"v":1,"id":"art","title":"Old Title","tools":[]}\'><html></html>';
    opfs.exists.mockResolvedValue(true);
    opfs.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith(".html")) return html;
      return JSON.stringify({
        id: "art", createdAt: "t", updatedAt: "t", approvedWrites: [], approvedNetwork: [], manifestVersion: "v", sourceConversationId: "c2"
      });
    });

    await renameArtifact("art", "New Title  ");
    expect(opfs.writeFileAtomic).toHaveBeenCalledTimes(2);
    const htmlCall = opfs.writeFileAtomic.mock.calls.find(([p]) => p.endsWith(".html"))!;
    expect(htmlCall[1]).toContain('"title":"New Title"');
  });

  it("throws if title is too long", async () => {
    await expect(renameArtifact("art", "A".repeat(81))).rejects.toThrow(/title must be 1-80 chars/);
  });
});

describe("setArtifactIcon", () => {
  it("rewrites the manifest meta tag with the new emoji", async () => {
    // Round-trip the inlined manifest: capture what setArtifactIcon writes,
    // then assert the new icon is present (and the prior value gone).
    const initialHtml =
      '<!doctype html><meta name="openbrowse:artifact" content=\'{"v":1,"id":"art","title":"X","icon":"🐛","tools":[]}\'><html></html>';
    let writtenHtml = initialHtml;
    opfs.exists.mockResolvedValue(true);
    opfs.writeFileAtomic.mockImplementation(async (p: string, c: string) => {
      if (p.endsWith(".html")) writtenHtml = c;
    });
    opfs.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith(".html")) return writtenHtml;
      return JSON.stringify({
        id: "art", createdAt: "t", updatedAt: "t",
        approvedWrites: [], approvedNetwork: [], manifestVersion: "v",
      });
    });

    await setArtifactIcon("art", "📈");
    const htmlCall = opfs.writeFileAtomic.mock.calls.find(([p]) => p.endsWith(".html"))!;
    expect(htmlCall[1]).toContain('"icon":"📈"');
    expect(htmlCall[1]).not.toContain('"icon":"🐛"');
  });

  it("trims whitespace and rejects an empty icon", async () => {
    await expect(setArtifactIcon("art", "   ")).rejects.toThrow(/icon must be 1-32 chars/);
  });

  it("rejects an icon longer than 32 chars", async () => {
    await expect(setArtifactIcon("art", "a".repeat(33))).rejects.toThrow(/icon must be 1-32 chars/);
  });
});

describe("setFavorite", () => {
  it("updates the favorite flag in the sidecar", async () => {
    opfs.exists.mockResolvedValue(true);
    opfs.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith(".meta.json")) {
        return JSON.stringify({
          id: "art", createdAt: "t", updatedAt: "t", approvedWrites: [], approvedNetwork: [], manifestVersion: "v"
        });
      }
      return "";
    });

    await setFavorite("art", true);
    expect(opfs.writeFileAtomic).toHaveBeenCalledTimes(1);
    const metaCall = opfs.writeFileAtomic.mock.calls[0];
    expect(metaCall[0]).toBe("artifacts/art.meta.json");
    expect(JSON.parse(metaCall[1]).favorite).toBe(true);

    await setFavorite("art", false);
    const metaCall2 = opfs.writeFileAtomic.mock.calls[1];
    expect(JSON.parse(metaCall2[1]).favorite).toBe(false);
  });
});

describe("artifacts:changed events", () => {
  function listen(): { events: string[]; stop: () => void } {
    const events: string[] = [];
    const handler = (e: Event) => {
      events.push(((e as CustomEvent).detail?.id as string) ?? "");
    };
    artifactsEvents.addEventListener("artifacts:changed", handler);
    return {
      events,
      stop: () => artifactsEvents.removeEventListener("artifacts:changed", handler),
    };
  }

  it("saveArtifact emits artifacts:changed with the id", async () => {
    const { events, stop } = listen();
    await saveArtifact({ manifest, html: "<html></html>", sourceConversationId: "c1" });
    stop();
    expect(events).toEqual(["linear-triage"]);
  });

  it("deleteArtifact emits artifacts:changed with the id", async () => {
    const { events, stop } = listen();
    await deleteArtifact("linear-triage");
    stop();
    expect(events).toEqual(["linear-triage"]);
  });
});
