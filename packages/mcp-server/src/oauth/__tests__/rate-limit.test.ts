import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("oauth/rate-limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("permits read RPCs up to the per-hour cap", async () => {
    const { createRateLimiter } = await import("../rate-limit");
    const rl = createRateLimiter({ readPerHour: 5, taskPerHour: 2, concurrentTasks: 1 });
    for (let i = 0; i < 5; i++) {
      expect(rl.tryConsume("c1", "read")).toBe("ok");
    }
    expect(rl.tryConsume("c1", "read")).toBe("rate_limited");
  });

  it("permits task RPCs up to the per-hour cap (independent of reads)", async () => {
    const { createRateLimiter } = await import("../rate-limit");
    const rl = createRateLimiter({ readPerHour: 100, taskPerHour: 2, concurrentTasks: 5 });
    expect(rl.tryConsume("c1", "task")).toBe("ok");
    expect(rl.tryConsume("c1", "task")).toBe("ok");
    expect(rl.tryConsume("c1", "task")).toBe("rate_limited");
    expect(rl.tryConsume("c1", "read")).toBe("ok");
  });

  it("isolates per-client buckets", async () => {
    const { createRateLimiter } = await import("../rate-limit");
    const rl = createRateLimiter({ readPerHour: 2, taskPerHour: 1, concurrentTasks: 1 });
    expect(rl.tryConsume("c1", "read")).toBe("ok");
    expect(rl.tryConsume("c1", "read")).toBe("ok");
    expect(rl.tryConsume("c1", "read")).toBe("rate_limited");
    expect(rl.tryConsume("c2", "read")).toBe("ok");
  });

  it("rolls over after one hour", async () => {
    const { createRateLimiter } = await import("../rate-limit");
    const rl = createRateLimiter({ readPerHour: 1, taskPerHour: 1, concurrentTasks: 1 });
    expect(rl.tryConsume("c1", "read")).toBe("ok");
    expect(rl.tryConsume("c1", "read")).toBe("rate_limited");
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(rl.tryConsume("c1", "read")).toBe("ok");
  });

  it("enforces concurrent-task cap", async () => {
    const { createRateLimiter } = await import("../rate-limit");
    const rl = createRateLimiter({ readPerHour: 100, taskPerHour: 100, concurrentTasks: 1 });
    expect(rl.startTask("c1")).toBe("ok");
    expect(rl.startTask("c1")).toBe("concurrent_limit");
    rl.endTask("c1");
    expect(rl.startTask("c1")).toBe("ok");
  });
});
