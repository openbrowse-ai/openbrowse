import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOwnership, STALE_OWNER_MS } from "../run-ownership";

describe("run-ownership", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    runOwnership._resetForTests();
  });

  afterEach(() => {
    runOwnership._resetForTests();
  });

  describe("claimOwnership", () => {
    it("lets the first claimant win and reports the owner", async () => {
      const won = await runOwnership.claimOwnership("conv-1", "token-A");
      expect(won).toBe(true);

      const owner = await runOwnership.getOwner("conv-1");
      expect(owner?.ownerToken).toBe("token-A");
    });

    it("rejects a second, different claimant while the first is live", async () => {
      const now = 1_000;
      expect(
        await runOwnership.claimOwnership("conv-1", "token-A", "home", now),
      ).toBe(true);
      // A moment later, a sibling tab tries to claim.
      expect(
        await runOwnership.claimOwnership("conv-1", "token-B", "home", now + 5),
      ).toBe(false);

      const owner = await runOwnership.getOwner("conv-1", now + 5);
      expect(owner?.ownerToken).toBe("token-A");
    });

    it("is idempotent for the current owner and refreshes the heartbeat", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);
      const reclaim = await runOwnership.claimOwnership(
        "conv-1",
        "token-A",
        "home",
        now + 100,
      );
      expect(reclaim).toBe(true);

      const owner = await runOwnership.getOwner("conv-1", now + 100);
      expect(owner?.ownerToken).toBe("token-A");
      expect(owner?.claimedAt).toBe(now); // claimedAt preserved
      expect(owner?.heartbeatAt).toBe(now + 100); // heartbeat refreshed
    });

    it("lets a new claimant reap a stale owner", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);

      // token-A never heartbeats; well past the stale threshold token-B claims.
      const later = now + STALE_OWNER_MS + 1;
      expect(
        await runOwnership.claimOwnership("conv-1", "token-B", "home", later),
      ).toBe(true);

      const owner = await runOwnership.getOwner("conv-1", later);
      expect(owner?.ownerToken).toBe("token-B");
    });

    it("does not allow reaping just before the stale threshold", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);

      const justBefore = now + STALE_OWNER_MS - 1;
      expect(
        await runOwnership.claimOwnership(
          "conv-1",
          "token-B",
          "home",
          justBefore,
        ),
      ).toBe(false);
    });

    it("scopes ownership per conversation", async () => {
      await runOwnership.claimOwnership("conv-1", "token-A");
      const ok = await runOwnership.claimOwnership("conv-2", "token-B");
      expect(ok).toBe(true);
      expect((await runOwnership.getOwner("conv-1"))?.ownerToken).toBe(
        "token-A",
      );
      expect((await runOwnership.getOwner("conv-2"))?.ownerToken).toBe(
        "token-B",
      );
    });
  });

  describe("renewOwnership", () => {
    it("refreshes the heartbeat for the current owner and prevents reaping", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);

      // Heartbeat just before the threshold keeps it alive.
      const renew = await runOwnership.renewOwnership(
        "conv-1",
        "token-A",
        now + STALE_OWNER_MS - 1,
      );
      expect(renew).toBe(true);

      // Now a claim that would have been stale relative to the ORIGINAL
      // claim is rejected because the heartbeat moved forward.
      const probe = now + STALE_OWNER_MS + 1;
      expect(
        await runOwnership.claimOwnership("conv-1", "token-B", "home", probe),
      ).toBe(false);
    });

    it("returns false when the token no longer owns the conversation", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);
      // token-B reaps it after staleness.
      const later = now + STALE_OWNER_MS + 1;
      await runOwnership.claimOwnership("conv-1", "token-B", "home", later);

      expect(
        await runOwnership.renewOwnership("conv-1", "token-A", later + 1),
      ).toBe(false);
    });
  });

  describe("releaseOwnership", () => {
    it("clears the claim so a new owner can take over immediately", async () => {
      await runOwnership.claimOwnership("conv-1", "token-A");
      await runOwnership.releaseOwnership("conv-1", "token-A");
      expect(await runOwnership.getOwner("conv-1")).toBeNull();

      expect(await runOwnership.claimOwnership("conv-1", "token-B")).toBe(true);
    });

    it("does not delete another owner's claim", async () => {
      await runOwnership.claimOwnership("conv-1", "token-A");
      await runOwnership.releaseOwnership("conv-1", "token-B"); // wrong token
      expect((await runOwnership.getOwner("conv-1"))?.ownerToken).toBe(
        "token-A",
      );
    });
  });

  describe("getOwner / isOwner", () => {
    it("reports a stale owner as null (reclaimable)", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);
      expect(
        await runOwnership.getOwner("conv-1", now + STALE_OWNER_MS + 1),
      ).toBeNull();
    });

    it("isOwner is true only for the live holder", async () => {
      const now = 1_000;
      await runOwnership.claimOwnership("conv-1", "token-A", "home", now);
      expect(await runOwnership.isOwner("conv-1", "token-A", now)).toBe(true);
      expect(await runOwnership.isOwner("conv-1", "token-B", now)).toBe(false);
      expect(
        await runOwnership.isOwner(
          "conv-1",
          "token-A",
          now + STALE_OWNER_MS + 1,
        ),
      ).toBe(false);
    });
  });
});
