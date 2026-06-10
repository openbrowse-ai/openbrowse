import { describe, expect, it, vi } from "vitest";
import type { CanonicalAction } from "../actions";
import { buildCuaNavTools } from "../nav-tools";

describe("buildCuaNavTools", () => {
  it("navigate runs a navigate action with the given url", async () => {
    const runAction = vi.fn(async () => ({
      imageDataUrl: "data:image/png;base64,QUJD",
      currentUrl: "https://x",
    }));
    const tools = buildCuaNavTools(
      runAction as (a: CanonicalAction) => Promise<{ imageDataUrl?: string }>,
    );
    await (tools.navigate.execute as (a: { url: string }) => Promise<unknown>)({
      url: "https://x",
    });
    expect(runAction).toHaveBeenCalledWith({ kind: "navigate", url: "https://x" });
  });

  it("goBack and goForward emit history actions", async () => {
    const runAction = vi.fn(async () => ({
      imageDataUrl: "data:image/png;base64,QUJD",
    }));
    const tools = buildCuaNavTools(
      runAction as (a: CanonicalAction) => Promise<{ imageDataUrl?: string }>,
    );
    await (tools.goBack.execute as (a: unknown) => Promise<unknown>)({});
    await (tools.goForward.execute as (a: unknown) => Promise<unknown>)({});
    expect(runAction).toHaveBeenNthCalledWith(1, { kind: "goBack" });
    expect(runAction).toHaveBeenNthCalledWith(2, { kind: "goForward" });
  });
});
