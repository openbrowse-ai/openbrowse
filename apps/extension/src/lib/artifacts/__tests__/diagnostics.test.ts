import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordConsole,
  recordError,
  recordRendered,
  readDiagnostics,
  clearDiagnostics,
  DIAGNOSTICS_MAX_ENTRIES,
  DIAGNOSTICS_TTL_MS,
} from "../diagnostics";

// Realistic in-memory chrome.storage.local backend (async via microtask), so
// the read-modify-write serialization in diagnostics.ts is exercised for real.
function makeStorage() {
  const store: Record<string, unknown> = {};
  return {
    store,
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
      }),
      remove: vi.fn(async (key: string) => {
        delete store[key];
      }),
    },
  };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal("chrome", { storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact diagnostics", () => {
  it("returns null when nothing recorded", async () => {
    expect(await readDiagnostics("weather")).toBeNull();
  });

  it("records and reads console entries", async () => {
    await recordConsole("weather", { level: "info", text: "fetched 12 items", ts: 1 });
    await recordConsole("weather", { level: "error", text: "boom", ts: 2 });
    const d = await readDiagnostics("weather");
    expect(d?.console).toHaveLength(2);
    expect(d?.console[0].text).toBe("fetched 12 items");
    expect(d?.console[1].level).toBe("error");
  });

  it("records error entries separately from console", async () => {
    await recordError("weather", { message: "TypeError x", stack: "at foo", ts: 5 });
    const d = await readDiagnostics("weather");
    expect(d?.errors).toHaveLength(1);
    expect(d?.errors[0].message).toBe("TypeError x");
    expect(d?.console).toHaveLength(0);
  });

  it("records the rendered signal", async () => {
    await recordRendered("weather", { childCount: 3, bodyTextSample: "Live Weather", ts: 9 });
    const d = await readDiagnostics("weather");
    expect(d?.rendered).toEqual({ childCount: 3, bodyTextSample: "Live Weather", ts: 9 });
  });

  it("caps the console buffer at DIAGNOSTICS_MAX_ENTRIES (drops oldest)", async () => {
    for (let i = 0; i < DIAGNOSTICS_MAX_ENTRIES + 10; i++) {
      await recordConsole("weather", { level: "log", text: `m${i}`, ts: i });
    }
    const d = await readDiagnostics("weather");
    expect(d?.console).toHaveLength(DIAGNOSTICS_MAX_ENTRIES);
    // Oldest dropped: first surviving entry is m10.
    expect(d?.console[0].text).toBe("m10");
    expect(d?.console[d.console.length - 1].text).toBe(`m${DIAGNOSTICS_MAX_ENTRIES + 9}`);
  });

  it("does not lose entries under concurrent (un-awaited) writes", async () => {
    // Fire many records without awaiting between them; the per-id write chain
    // must serialize the read-modify-write so none clobber each other.
    const writes = [];
    for (let i = 0; i < 20; i++) {
      writes.push(recordConsole("weather", { level: "log", text: `c${i}`, ts: i }));
    }
    await Promise.all(writes);
    const d = await readDiagnostics("weather");
    expect(d?.console).toHaveLength(20);
  });

  it("clears a buffer", async () => {
    await recordConsole("weather", { level: "log", text: "x", ts: 1 });
    await clearDiagnostics("weather");
    expect(await readDiagnostics("weather")).toBeNull();
  });

  it("treats a buffer older than the TTL as stale and clears it", async () => {
    await recordConsole("weather", { level: "log", text: "x", ts: 1 });
    const d = await readDiagnostics("weather");
    const startedAt = d!.startedAt;
    // Read far in the future.
    const future = startedAt + DIAGNOSTICS_TTL_MS + 1;
    expect(await readDiagnostics("weather", future)).toBeNull();
    // And the stale entry was removed from storage.
    expect(await readDiagnostics("weather")).toBeNull();
  });

  it("keeps separate buffers per artifact id", async () => {
    await recordConsole("a", { level: "log", text: "from-a", ts: 1 });
    await recordConsole("b", { level: "log", text: "from-b", ts: 1 });
    expect((await readDiagnostics("a"))?.console[0].text).toBe("from-a");
    expect((await readDiagnostics("b"))?.console[0].text).toBe("from-b");
  });
});
