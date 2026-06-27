import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollDiagnostics } from "../read-artifact-diagnostics";
import type { ArtifactDiagnostics } from "@/lib/artifacts/diagnostics";

function diag(over: Partial<ArtifactDiagnostics> = {}): ArtifactDiagnostics {
  return {
    artifactId: "weather",
    startedAt: 1000,
    console: [],
    errors: [],
    rendered: null,
    ...over,
  };
}

// A controllable clock: now() advances by `step` each time sleep() is called,
// so polling terminates deterministically without real timers.
function fakeClock(step: number) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (_ms: number) => {
      t += step;
    },
  };
}

describe("pollDiagnostics", () => {
  it("returns immediately when the first read already shows a render", async () => {
    const clock = fakeClock(100);
    const read = vi.fn(async () => diag({ rendered: { childCount: 2, bodyTextSample: "hi", ts: 1 } }));
    const { diagnostics, waitedMs } = await pollDiagnostics("weather", {
      waitMs: 3000,
      read,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(diagnostics?.rendered).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(waitedMs).toBe(0);
  });

  it("returns as soon as an error appears", async () => {
    const clock = fakeClock(100);
    let calls = 0;
    const read = vi.fn(async () => {
      calls++;
      return calls >= 3
        ? diag({ errors: [{ message: "boom", ts: 1 }] })
        : diag();
    });
    const { diagnostics } = await pollDiagnostics("weather", {
      waitMs: 3000,
      read,
      sleep: clock.sleep,
      now: clock.now,
      intervalMs: 100,
    });
    expect(diagnostics?.errors).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up after the wait budget when nothing conclusive arrives", async () => {
    const clock = fakeClock(100);
    const read = vi.fn(async () => diag()); // never conclusive
    const { diagnostics, waitedMs } = await pollDiagnostics("weather", {
      waitMs: 300,
      read,
      sleep: clock.sleep,
      now: clock.now,
      intervalMs: 100,
    });
    expect(diagnostics?.rendered).toBeNull();
    expect(diagnostics?.errors).toHaveLength(0);
    expect(waitedMs).toBeGreaterThanOrEqual(300);
  });

  it("returns null diagnostics when the buffer never exists", async () => {
    const clock = fakeClock(100);
    const read = vi.fn(async () => null);
    const { diagnostics } = await pollDiagnostics("weather", {
      waitMs: 200,
      read,
      sleep: clock.sleep,
      now: clock.now,
      intervalMs: 100,
    });
    expect(diagnostics).toBeNull();
  });
});

// execute() path: mock the diagnostics module to drive note/shape behavior.
const diagMod = vi.hoisted(() => ({ readDiagnostics: vi.fn() }));
vi.mock("@/lib/artifacts/diagnostics", () => diagMod);

import { readArtifactDiagnosticsTool } from "../read-artifact-diagnostics";

beforeEach(() => {
  diagMod.readDiagnostics.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function runExecute(input: { artifactId: string; waitMs?: number }) {
  const p = readArtifactDiagnosticsTool.execute(input, {} as never);
  await vi.runAllTimersAsync();
  return p;
}

describe("readArtifactDiagnosticsTool.execute", () => {
  it("notes a missing buffer (preview not mounted)", async () => {
    diagMod.readDiagnostics.mockResolvedValue(null);
    const out = await runExecute({ artifactId: "weather", waitMs: 200 });
    expect(out.rendered).toBeNull();
    expect(out.startedAt).toBeNull();
    expect(out.note).toMatch(/may not have mounted/i);
  });

  it("returns a clean result with no note when rendered and no errors", async () => {
    diagMod.readDiagnostics.mockResolvedValue({
      artifactId: "weather",
      startedAt: 1000,
      console: [{ level: "info", text: "ok", ts: 1 }],
      errors: [],
      rendered: { childCount: 2, bodyTextSample: "Live Weather", ts: 2 },
    });
    const out = await runExecute({ artifactId: "weather" });
    expect(out.rendered).toEqual({ childCount: 2, bodyTextSample: "Live Weather" });
    expect(out.errors).toHaveLength(0);
    expect(out.note).toBeUndefined();
  });

  it("flags errors with a fix-and-recheck note", async () => {
    diagMod.readDiagnostics.mockResolvedValue({
      artifactId: "weather",
      startedAt: 1000,
      console: [],
      errors: [{ message: "TypeError: x is not a function", ts: 3 }],
      rendered: null,
    });
    const out = await runExecute({ artifactId: "weather" });
    expect(out.errors).toHaveLength(1);
    expect(out.note).toMatch(/update_artifact/);
  });
});
