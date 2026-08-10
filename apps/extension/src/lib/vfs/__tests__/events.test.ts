import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `events.ts` decides at module-load time whether to open a BroadcastChannel,
 * so each test stubs the globals it wants to simulate and then pulls in a
 * fresh copy of the module via `vi.resetModules()` + dynamic import.
 */

interface Posted {
  path: string;
}

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  onmessage: ((event: { data: Posted }) => void) | null = null;
  readonly posted: Posted[] = [];

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(data: Posted) {
    this.posted.push(data);
    // A real BroadcastChannel never echoes to the posting context; it fans out
    // to every *other* context subscribed to the same name.
    for (const other of FakeBroadcastChannel.instances) {
      if (other !== this && other.name === this.name)
        other.onmessage?.({ data });
    }
  }

  close() {}
}

async function loadEvents() {
  vi.resetModules();
  return import("../events");
}

beforeEach(() => {
  FakeBroadcastChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vfs events", () => {
  it("dispatches locally and mirrors onto the channel for other contexts", async () => {
    vi.stubGlobal("window", {});
    const { emitVfsChange, vfsEvents } = await loadEvents();

    const seen: string[] = [];
    vfsEvents.addEventListener("vfs:change", (e) => {
      seen.push((e as CustomEvent<{ path: string }>).detail.path);
    });

    emitVfsChange("memory/garry-tan.md");

    expect(seen).toEqual(["memory/garry-tan.md"]);
    expect(FakeBroadcastChannel.instances).toHaveLength(1);
    expect(FakeBroadcastChannel.instances[0].posted).toEqual([
      { path: "memory/garry-tan.md" },
    ]);
  });

  it("re-emits a write from another extension context on the local bus", async () => {
    vi.stubGlobal("window", {});
    const { vfsEvents } = await loadEvents();

    // Stand-in for the service worker: same channel name, different instance.
    const serviceWorker = new FakeBroadcastChannel("openbrowse:vfs-change");

    const seen: string[] = [];
    vfsEvents.addEventListener("vfs:change", (e) => {
      seen.push((e as CustomEvent<{ path: string }>).detail.path);
    });

    serviceWorker.postMessage({ path: "memory/garry-tan.md" });

    expect(seen).toEqual(["memory/garry-tan.md"]);
  });

  it("opens a channel in the service worker (no window, SW global scope)", async () => {
    vi.stubGlobal("ServiceWorkerGlobalScope", class {});
    const { emitVfsChange } = await loadEvents();

    emitVfsChange("memory/a.md");

    expect(FakeBroadcastChannel.instances).toHaveLength(1);
  });

  it("stays local-only outside an extension context", async () => {
    const { emitVfsChange, vfsEvents } = await loadEvents();

    const seen: string[] = [];
    vfsEvents.addEventListener("vfs:change", (e) => {
      seen.push((e as CustomEvent<{ path: string }>).detail.path);
    });

    emitVfsChange("memory/a.md");

    expect(seen).toEqual(["memory/a.md"]);
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
  });
});
