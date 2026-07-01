export type RateBucket = "read" | "task";
export type RateOutcome = "ok" | "rate_limited";
export type ConcurrentOutcome = "ok" | "concurrent_limit";

export interface RateLimitConfig {
  readPerHour: number;
  taskPerHour: number;
  concurrentTasks: number;
}

const HOUR_MS = 60 * 60 * 1000;

interface BucketState {
  windowStart: number;
  count: number;
}

interface ClientState {
  read: BucketState;
  task: BucketState;
  inFlightTasks: number;
}

function freshBucket(now: number): BucketState {
  return { windowStart: now, count: 0 };
}

function freshClient(now: number): ClientState {
  return { read: freshBucket(now), task: freshBucket(now), inFlightTasks: 0 };
}

function rollover(bucket: BucketState, now: number): void {
  if (now - bucket.windowStart >= HOUR_MS) {
    bucket.windowStart = now;
    bucket.count = 0;
  }
}

export interface RateLimiter {
  tryConsume(clientId: string, bucket: RateBucket): RateOutcome;
  startTask(clientId: string): ConcurrentOutcome;
  endTask(clientId: string): void;
}

export function createRateLimiter(cfg: RateLimitConfig): RateLimiter {
  const clients = new Map<string, ClientState>();

  function state(clientId: string): ClientState {
    let s = clients.get(clientId);
    if (!s) {
      s = freshClient(Date.now());
      clients.set(clientId, s);
    }
    return s;
  }

  return {
    tryConsume(clientId, bucket) {
      const s = state(clientId);
      const now = Date.now();
      const b = s[bucket];
      rollover(b, now);
      const cap = bucket === "read" ? cfg.readPerHour : cfg.taskPerHour;
      if (b.count >= cap) return "rate_limited";
      b.count += 1;
      return "ok";
    },
    startTask(clientId) {
      const s = state(clientId);
      if (s.inFlightTasks >= cfg.concurrentTasks) return "concurrent_limit";
      s.inFlightTasks += 1;
      return "ok";
    },
    endTask(clientId) {
      const s = state(clientId);
      s.inFlightTasks = Math.max(0, s.inFlightTasks - 1);
    },
  };
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  readPerHour: 200,
  taskPerHour: 30,
  concurrentTasks: 1,
};
