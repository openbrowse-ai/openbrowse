import { describe, expect, it } from "vitest";
import { withLocalEngineLock } from "../engine-lock";

/**
 * `withLocalEngineLock` serializes on-device generations so the shared WebGPU /
 * Nano engine is never double-loaded (the "UI freezes right after send" bug).
 * The lock keeps module-level state, so every test awaits its own work to
 * settle before finishing.
 */
describe("withLocalEngineLock", () => {
  it("runs queued work one at a time, in FIFO order", async () => {
    const events: string[] = [];
    const task = (name: string, ms: number) =>
      withLocalEngineLock(async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${name}:end`);
        return name;
      });

    // Deliberately give the first task the longest delay: if the lock were not
    // serializing, "b" would start before "a" finished.
    const results = await Promise.all([task("a", 20), task("b", 1), task("c", 1)]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("propagates the rejection to its own caller", async () => {
    await expect(
      withLocalEngineLock(async () => {
        throw new Error("generation failed");
      }),
    ).rejects.toThrow("generation failed");
  });

  it("does not wedge the queue after a rejection", async () => {
    const failed = withLocalEngineLock(async () => {
      throw new Error("boom");
    });
    // Queue a follow-up before the failure settles, so it is chained onto the
    // rejected link rather than a fresh one.
    const after = withLocalEngineLock(async () => "recovered");

    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("recovered");
  });

  it("still serializes work queued after a rejection", async () => {
    const events: string[] = [];
    const boom = withLocalEngineLock(async () => {
      events.push("boom");
      throw new Error("boom");
    });
    const next = withLocalEngineLock(async () => {
      events.push("next:start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("next:end");
    });

    await expect(boom).rejects.toThrow("boom");
    await next;
    expect(events).toEqual(["boom", "next:start", "next:end"]);
  });
});
