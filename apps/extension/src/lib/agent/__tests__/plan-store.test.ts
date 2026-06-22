import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import * as planStore from "@/lib/agent/plan-store";
import { planExtensionForCall } from "../plan-store";

const CID = "conv-plan-test";

describe("plan-store", () => {
  beforeEach(async () => {
    // Fresh IDB + chatDb singleton per test (matches chat-db-delete.test.ts).
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function importStore() {
    // Seed a conversation row so updates have something to update.
    await chatDb.createConversation({
      id: CID,
      title: "test",
      spaceId: null,
      ownedGroupId: null,
      ownedLtids: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { chatDb, planStore };
  }

  it("getPlan returns undefined when no plan is set", async () => {
    const { planStore } = await importStore();
    expect(await planStore.getPlan(CID)).toBeUndefined();
  });

  it("setPlan persists the plan and getPlan reads it back", async () => {
    const { planStore } = await importStore();
    const plan = {
      goal: "Find best OSS coding model",
      sites: ["https://kilo.ai"],
      allowNetwork: false,
      approvedAt: 1000,
      extensions: [],
    };
    await planStore.setPlan(CID, plan);
    expect(await planStore.getPlan(CID)).toEqual(plan);
  });

  it("extendPlanWithSite appends a normalized origin and an extension entry", async () => {
    const { planStore } = await importStore();
    await planStore.setPlan(CID, {
      goal: "g",
      sites: ["https://a.com"],
      allowNetwork: false,
      approvedAt: 1000,
      extensions: [],
    });
    await planStore.extendPlanWithSite(CID, "https://b.com");
    const plan = await planStore.getPlan(CID);
    expect(plan?.sites).toEqual(["https://a.com", "https://b.com"]);
    expect(plan?.extensions).toHaveLength(1);
    expect(plan?.extensions[0]).toMatchObject({
      kind: "site",
      site: "https://b.com",
    });
  });

  it("extendPlanWithSite is a no-op when the site is already present", async () => {
    const { planStore } = await importStore();
    await planStore.setPlan(CID, {
      goal: "g",
      sites: ["https://a.com"],
      allowNetwork: false,
      approvedAt: 1000,
      extensions: [],
    });
    await planStore.extendPlanWithSite(CID, "https://a.com");
    const plan = await planStore.getPlan(CID);
    expect(plan?.sites).toEqual(["https://a.com"]);
    expect(plan?.extensions).toHaveLength(0);
  });

  it("extendPlanWithSite normalizes input via URL().origin", async () => {
    const { planStore } = await importStore();
    await planStore.setPlan(CID, {
      goal: "g",
      sites: [],
      allowNetwork: false,
      approvedAt: 1000,
      extensions: [],
    });
    // Pass a full URL — store should normalize to origin.
    await planStore.extendPlanWithSite(CID, "https://x.com/some/path?q=1");
    expect((await planStore.getPlan(CID))?.sites).toEqual(["https://x.com"]);
  });

  it("flipPlanNetwork sets allowNetwork to true and records an extension", async () => {
    const { planStore } = await importStore();
    await planStore.setPlan(CID, {
      goal: "g",
      sites: [],
      allowNetwork: false,
      approvedAt: 1000,
      extensions: [],
    });
    await planStore.flipPlanNetwork(CID);
    const plan = await planStore.getPlan(CID);
    expect(plan?.allowNetwork).toBe(true);
    expect(plan?.extensions).toHaveLength(1);
    expect(plan?.extensions[0]).toMatchObject({ kind: "network" });
  });

  it("flipPlanNetwork is a no-op when allowNetwork is already true", async () => {
    const { planStore } = await importStore();
    await planStore.setPlan(CID, {
      goal: "g",
      sites: [],
      allowNetwork: true,
      approvedAt: 1000,
      extensions: [],
    });
    await planStore.flipPlanNetwork(CID);
    const plan = await planStore.getPlan(CID);
    expect(plan?.extensions).toHaveLength(0);
  });

  it("plan-store operations are no-ops when the conversation does not exist", async () => {
    // Don't seed; importStore seeds CID, so use a different cid.
    const { planStore } = await importStore();
    await planStore.setPlan("nonexistent", {
      goal: "g",
      sites: [],
      allowNetwork: false,
      approvedAt: 0,
      extensions: [],
    });
    expect(await planStore.getPlan("nonexistent")).toBeUndefined();
  });
});

describe("planExtensionForCall", () => {
  const basePlan = {
    goal: "g",
    sites: ["https://a.com"],
    allowNetwork: false,
    approvedAt: 0,
    extensions: [],
  };

  it("returns none for executePython without network", () => {
    expect(
      planExtensionForCall({
        toolKey: "executePython",
        inputAllowNetwork: false,
        plan: basePlan,
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns network for executePython with network when plan disallows", () => {
    expect(
      planExtensionForCall({
        toolKey: "executePython",
        inputAllowNetwork: true,
        plan: basePlan,
      }),
    ).toEqual({ kind: "network" });
  });

  it("returns none for executePython with network when plan already allows", () => {
    expect(
      planExtensionForCall({
        toolKey: "executePython",
        inputAllowNetwork: true,
        plan: { ...basePlan, allowNetwork: true },
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns site for tab tools targeting an off-plan origin", () => {
    expect(
      planExtensionForCall({
        toolKey: "executeOnPage",
        targetOrigin: "https://b.com",
        plan: basePlan,
      }),
    ).toEqual({ kind: "site", origin: "https://b.com" });
  });

  it("returns none for tab tools on an in-plan origin", () => {
    expect(
      planExtensionForCall({
        toolKey: "executeOnPage",
        targetOrigin: "https://a.com",
        plan: basePlan,
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none when targetOrigin is missing (unresolvable tab)", () => {
    expect(
      planExtensionForCall({
        toolKey: "executeOnPage",
        plan: basePlan,
      }),
    ).toEqual({ kind: "none" });
  });
});
