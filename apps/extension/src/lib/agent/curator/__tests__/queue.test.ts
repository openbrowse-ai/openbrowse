import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import {
  enqueueCuratorJob,
  dequeueCuratorJob,
  peekCuratorQueue,
} from "../queue";
import { OPFS } from "../../../vfs/opfs";
import { installFakeOpfs } from "@/lib/vfs/__tests__/fake-opfs";

const cand = (code: string) => ({
  domain: "linkedin.com",
  code,
  observedResult: "[1]",
});

beforeAll(() => {
  installFakeOpfs(vi);
});

describe("curator queue", () => {
  beforeEach(async () => {
    await OPFS.rm("curator-queue.json").catch(() => {});
  });

  it("enqueues and dequeues FIFO", async () => {
    await enqueueCuratorJob({
      conversationId: "c1",
      domain: "linkedin.com",
      candidates: [cand("a")],
      toolHistory: "h",
    });
    const peek = await peekCuratorQueue();
    expect(peek).toHaveLength(1);
    const job = await dequeueCuratorJob();
    expect(job?.conversationId).toBe("c1");
    expect(await dequeueCuratorJob()).toBeNull();
  });

  it("coalesces by (conversationId, domain) — replace", async () => {
    await enqueueCuratorJob({
      conversationId: "c1",
      domain: "linkedin.com",
      candidates: [cand("old")],
      toolHistory: "h1",
    });
    await enqueueCuratorJob({
      conversationId: "c1",
      domain: "linkedin.com",
      candidates: [cand("new")],
      toolHistory: "h2",
    });
    const peek = await peekCuratorQueue();
    expect(peek).toHaveLength(1);
    expect(peek[0].candidates[0].code).toBe("new");
  });

  it("keeps distinct keys separate", async () => {
    await enqueueCuratorJob({
      conversationId: "c1",
      domain: "linkedin.com",
      candidates: [cand("a")],
      toolHistory: "h",
    });
    await enqueueCuratorJob({
      conversationId: "c2",
      domain: "linkedin.com",
      candidates: [cand("b")],
      toolHistory: "h",
    });
    expect(await peekCuratorQueue()).toHaveLength(2);
  });
});
