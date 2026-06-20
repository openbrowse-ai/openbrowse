import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { drainCuratorQueue } from "../runner";
import { enqueueCuratorJob } from "../queue";
import { OPFS } from "../../../vfs/opfs";
import { installFakeOpfs } from "./fake-opfs";

beforeAll(() => {
  installFakeOpfs();
});

beforeEach(async () => {
  await OPFS.rm("curator-queue.json").catch(() => {});
});

const job = (conv: string) => ({
  conversationId: conv,
  domain: "linkedin.com",
  candidates: [
    { domain: "linkedin.com", code: "x".repeat(100), observedResult: "[1]" },
  ],
  toolHistory: "history",
});

describe("drainCuratorQueue", () => {
  it("processes all queued jobs via the injected runner", async () => {
    await enqueueCuratorJob(job("c1"));
    await enqueueCuratorJob(job("c2"));
    const seen: string[] = [];
    const runAgent = vi.fn(async (j) => {
      seen.push(j.conversationId);
    });
    await drainCuratorQueue({ runAgent });
    expect(seen.sort()).toEqual(["c1", "c2"]);
    expect(await OPFS.readFile("curator-queue.json").catch(() => "[]")).toBe(
      "[]",
    );
  });

  it("is reentrancy-safe: a second concurrent drain is a no-op", async () => {
    await enqueueCuratorJob(job("c1"));
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    const runAgent = vi.fn(async () => {
      await gate;
    });
    const p1 = drainCuratorQueue({ runAgent });
    const p2 = drainCuratorQueue({ runAgent }); // should bail immediately
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("continues draining if one job throws", async () => {
    await enqueueCuratorJob(job("c1"));
    await enqueueCuratorJob(job("c2"));
    const runAgent = vi.fn(async (j) => {
      if (j.conversationId === "c1") throw new Error("boom");
    });
    await drainCuratorQueue({ runAgent });
    expect(runAgent).toHaveBeenCalledTimes(2);
  });
});
