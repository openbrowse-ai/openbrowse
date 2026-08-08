import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../download-queue";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSerialQueue", () => {
  it("dedupes concurrent requests for the same key onto one promise", async () => {
    const q = createSerialQueue();
    const d = deferred<string>();
    let calls = 0;
    const task = () => {
      calls++;
      return d.promise;
    };

    const p1 = q.run("k", task);
    const p2 = q.run("k", task);

    // Same promise handed back — the task was not invoked a second time.
    expect(p1).toBe(p2);

    d.resolve("done");
    await expect(p1).resolves.toBe("done");
    expect(calls).toBe(1);
  });

  it("runs tasks one at a time in FIFO order", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const dA = deferred<void>();

    const pA = q.run("A", async () => {
      order.push("A-start");
      await dA.promise;
      order.push("A-end");
    });
    const pB = q.run("B", async () => {
      order.push("B-start");
    });

    await tick();
    // B must not start until A finishes.
    expect(order).toEqual(["A-start"]);

    dA.resolve();
    await Promise.all([pA, pB]);
    expect(order).toEqual(["A-start", "A-end", "B-start"]);
  });

  it("keeps running the queue after a task rejects", async () => {
    const q = createSerialQueue();
    const order: string[] = [];

    const pA = q.run("A", async () => {
      order.push("A");
      throw new Error("boom");
    });
    const pB = q.run("B", async () => {
      order.push("B");
    });

    await expect(pA).rejects.toThrow("boom");
    await pB;
    expect(order).toEqual(["A", "B"]);
  });

  it("allows the same key to run again after it settles", async () => {
    const q = createSerialQueue();
    let calls = 0;
    await q.run("k", async () => {
      calls++;
    });
    await q.run("k", async () => {
      calls++;
    });
    expect(calls).toBe(2);
  });

  it("reports active state while work is queued", async () => {
    const q = createSerialQueue();
    const d = deferred<void>();
    expect(q.isActive()).toBe(false);
    const p = q.run("k", () => d.promise);
    expect(q.isActive()).toBe(true);
    d.resolve();
    await p;
    await tick();
    expect(q.isActive()).toBe(false);
  });
});
