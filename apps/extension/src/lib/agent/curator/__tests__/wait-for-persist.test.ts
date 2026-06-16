import { describe, it, expect, vi } from "vitest";
import {
  waitForAssistantPersist,
  type PersistWaitDeps,
} from "../wait-for-persist";

describe("waitForAssistantPersist", () => {
  it("returns immediately when a message is already persisted past baseline", async () => {
    const deps: PersistWaitDeps = {
      getMessageCount: vi.fn(async () => 3),
      subscribeMessageChange: vi.fn(() => () => {}),
    };
    const count = await waitForAssistantPersist(deps, "c1", 2);
    expect(count).toBe(3);
    // Fast path: never needs to subscribe.
    expect(deps.subscribeMessageChange).not.toHaveBeenCalled();
  });

  it("resolves when a message-change event lands for the conversation", async () => {
    let count = 2; // baseline; assistant message not yet persisted
    let emit: ((cid: string) => void) | null = null;
    const deps: PersistWaitDeps = {
      getMessageCount: vi.fn(async () => count),
      subscribeMessageChange: vi.fn((listener) => {
        emit = listener;
        return () => {
          emit = null;
        };
      }),
    };

    const pending = waitForAssistantPersist(deps, "c1", 2);
    // The fast-path getMessageCount await must settle before the subscription
    // is registered. Flush microtasks so `emit` is assigned.
    await Promise.resolve();
    await Promise.resolve();
    // Persist the assistant message, then fire the pubsub event.
    count = 3;
    emit!("c1");

    expect(await pending).toBe(3);
    // Subscription cleaned up after resolution.
    expect(emit).toBeNull();
  });

  it("ignores events for other conversations", async () => {
    let count = 2;
    let emit: ((cid: string) => void) | null = null;
    const deps: PersistWaitDeps = {
      getMessageCount: vi.fn(async () => count),
      subscribeMessageChange: vi.fn((listener) => {
        emit = listener;
        return () => {};
      }),
    };

    const pending = waitForAssistantPersist(deps, "c1", 2, 50);
    await Promise.resolve();
    await Promise.resolve();
    // Event for a different conversation must not resolve.
    count = 9;
    emit!("other");
    // The timeout fallback (50ms) eventually resolves with the live count.
    expect(await pending).toBe(9);
  });

  it("falls back to the live count on timeout when no event fires", async () => {
    vi.useFakeTimers();
    try {
      let count = 2;
      const deps: PersistWaitDeps = {
        getMessageCount: vi.fn(async () => count),
        subscribeMessageChange: vi.fn(() => () => {}),
      };
      const pending = waitForAssistantPersist(deps, "c1", 2, 5000);
      count = 3; // persisted but no event delivered
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
