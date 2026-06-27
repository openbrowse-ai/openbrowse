import { describe, it, expect } from "vitest";
import { checkAllowlist, isArtifactRpcMessage, ARTIFACT_RPC_PREFIX } from "../rpc";
import type { ArtifactManifest, ArtifactSidecar } from "../manifest";

const m: ArtifactManifest = {
  v: 1, id: "x", title: "X",
  tools: [
    { name: "mcp.linear.search_issues", mode: "read" },
    { name: "mcp.linear.update_issue", mode: "write" },
    { name: "browser.read_page", mode: "read" },
  ],
};
const s: ArtifactSidecar = {
  id: "x", createdAt: "t", updatedAt: "t",
  approvedWrites: ["mcp.linear.update_issue"],
  approvedNetwork: [],
  manifestVersion: "v",
};

describe("checkAllowlist", () => {
  it("allows declared read tools without approval", () => {
    expect(checkAllowlist(m, s, "mcp.linear.search_issues")).toEqual({ ok: true });
  });

  it("allows declared write tools that are approved", () => {
    expect(checkAllowlist(m, s, "mcp.linear.update_issue")).toEqual({ ok: true });
  });

  it("rejects undeclared tools", () => {
    const r = checkAllowlist(m, s, "mcp.linear.delete_issue");
    expect(r.ok).toBe(false);
  });

  it("rejects declared writes that are not approved", () => {
    const r = checkAllowlist(m, { ...s, approvedWrites: [] }, "mcp.linear.update_issue");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not approved/i);
  });
});

describe("isArtifactRpcMessage", () => {
  // The background router (background/index.ts) dispatches to handleArtifactRpc
  // based on this predicate. EVERY host->background artifact message must
  // satisfy it, or it silently never reaches a handler and
  // chrome.runtime.sendMessage resolves undefined with no error. This is the
  // exact bug that broke network.fetch when its type lacked the RPC prefix.

  it("accepts every host->background artifact message type", () => {
    for (const type of [
      "ARTIFACT_RPC_CALL_MCP",
      "ARTIFACT_RPC_RUN_TOOL",
      "ARTIFACT_RPC_NETWORK_FETCH",
    ]) {
      expect(isArtifactRpcMessage({ type })).toBe(true);
    }
  });

  it("rejects unrelated message types", () => {
    expect(isArtifactRpcMessage({ type: "MCP_CALL" })).toBe(false);
    expect(isArtifactRpcMessage({ type: "SKILL_LIST" })).toBe(false);
    expect(isArtifactRpcMessage({ type: "ARTIFACT_NETWORK_FETCH" })).toBe(false); // pre-fix typo
  });

  it("rejects malformed messages", () => {
    expect(isArtifactRpcMessage(undefined)).toBe(false);
    expect(isArtifactRpcMessage(null)).toBe(false);
    expect(isArtifactRpcMessage({})).toBe(false);
    expect(isArtifactRpcMessage({ type: 42 })).toBe(false);
    expect(isArtifactRpcMessage("ARTIFACT_RPC_CALL_MCP")).toBe(false);
  });

  it("every declared host->background type carries the prefix", () => {
    // Guards the contract: if someone adds a HostToBackgroundMessage variant
    // without the prefix, this list (and the router) would miss it.
    const types = [
      "ARTIFACT_RPC_CALL_MCP",
      "ARTIFACT_RPC_RUN_TOOL",
      "ARTIFACT_RPC_NETWORK_FETCH",
    ];
    for (const t of types) expect(t.startsWith(ARTIFACT_RPC_PREFIX)).toBe(true);
  });
});
