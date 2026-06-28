import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, type RunHandle } from "../registry";

/**
 * The agent-host registry is a tiny in-memory map from conversationId to
 * the live `RunHandle` for that conversation's SW-hosted run. It is the
 * single source of truth for "is there a run going for this conversation?"
 * — replacing the per-renderer `runOwnership` IDB lock.
 *
 * Contract:
 *   - register(handle) inserts; throws if a handle for the same
 *     conversationId already exists (caller must release first or detect
 *     in-flight duplicate start).
 *   - get(conversationId) returns the handle or undefined.
 *   - release(conversationId) removes; idempotent for unknown ids.
 *   - list() returns a snapshot array, used by SW-startup orphan recovery.
 */

function makeHandle(conversationId: string): RunHandle {
  return {
    conversationId,
    abort: new AbortController(),
    startedAt: Date.now(),
    status: "running",
    subscribers: new Set(),
  };
}

describe("agent-host registry", () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
  });

  it("register stores a handle retrievable by conversationId", () => {
    const handle = makeHandle("conv-A");
    registry.register(handle);
    expect(registry.get("conv-A")).toBe(handle);
  });

  it("register throws if a handle for the same conversationId is already present", () => {
    registry.register(makeHandle("conv-A"));
    expect(() => registry.register(makeHandle("conv-A"))).toThrow(
      /already registered/i,
    );
  });

  it("get returns undefined for an unknown conversationId", () => {
    expect(registry.get("conv-missing")).toBeUndefined();
  });

  it("release removes the handle", () => {
    const handle = makeHandle("conv-A");
    registry.register(handle);
    registry.release("conv-A");
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("release is idempotent for unknown conversationIds", () => {
    expect(() => registry.release("conv-never-registered")).not.toThrow();
  });

  it("list returns a snapshot of all registered handles", () => {
    const a = makeHandle("conv-A");
    const b = makeHandle("conv-B");
    registry.register(a);
    registry.register(b);
    const snapshot = registry.list();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((h) => h.conversationId).sort()).toEqual([
      "conv-A",
      "conv-B",
    ]);
  });

  it("list snapshot is decoupled from the live map", () => {
    registry.register(makeHandle("conv-A"));
    const snapshot = registry.list();
    registry.register(makeHandle("conv-B"));
    expect(snapshot).toHaveLength(1);
    expect(registry.list()).toHaveLength(2);
  });

  it("releases do not affect other conversations", () => {
    const a = makeHandle("conv-A");
    const b = makeHandle("conv-B");
    registry.register(a);
    registry.register(b);
    registry.release("conv-A");
    expect(registry.get("conv-A")).toBeUndefined();
    expect(registry.get("conv-B")).toBe(b);
  });

  it("after release, register with the same id succeeds again", () => {
    registry.register(makeHandle("conv-A"));
    registry.release("conv-A");
    const next = makeHandle("conv-A");
    expect(() => registry.register(next)).not.toThrow();
    expect(registry.get("conv-A")).toBe(next);
  });

  it("RunHandle.subscribers starts empty and accepts ports", () => {
    const handle = makeHandle("conv-A");
    registry.register(handle);
    const fakePort = { name: "agent-run:conv-A" } as unknown as chrome.runtime.Port;
    handle.subscribers.add(fakePort);
    expect(handle.subscribers.size).toBe(1);
    expect(registry.get("conv-A")?.subscribers.has(fakePort)).toBe(true);
  });

  it("RunHandle.abort is an AbortController whose signal can fire", () => {
    const handle = makeHandle("conv-A");
    registry.register(handle);
    const onAbort = vi.fn();
    handle.abort.signal.addEventListener("abort", onAbort);
    handle.abort.abort();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(handle.abort.signal.aborted).toBe(true);
  });
});
