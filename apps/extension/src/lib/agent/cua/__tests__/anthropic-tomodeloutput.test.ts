import { describe, expect, it, vi } from "vitest";

// Capture the options passed to the computer tool factory so we can invoke
// its `toModelOutput` directly. We mock `@ai-sdk/anthropic` to expose the
// factory options, and `./cua-loop` to immediately invoke the `build`
// callback with stub loop args and return whatever tool config it produced.
const captured: { toModelOutput?: (arg: { output: unknown }) => unknown } = {};

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => ({
    tools: new Proxy(
      {},
      {
        get: () => (opts: { toModelOutput?: (a: { output: unknown }) => unknown }) => {
          captured.toModelOutput = opts.toModelOutput;
          return { __isComputerTool: true };
        },
      },
    ),
  }),
}));

vi.mock("../cua-loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cua-loop")>();
  return {
    ...actual,
    runCuaToolLoop: async (
      _cfg: unknown,
      build: (args: {
        downscale: number;
        displayWidth: number;
        displayHeight: number;
        runAction: () => Promise<unknown>;
      }) => unknown,
    ) => {
      build({
        downscale: 1,
        displayWidth: 1280,
        displayHeight: 800,
        runAction: async () => ({ imageDataUrl: "data:image/png;base64,QUJD" }),
      });
      return { finalText: "ok", status: "completed" };
    },
  };
});

import { createAnthropicCuaProvider } from "../anthropic";

describe("Anthropic computer tool toModelOutput", () => {
  it("converts { imageDataUrl } into an image-data content part", async () => {
    const provider = createAnthropicCuaProvider("sk-test");
    await provider.runLoop({
      model: {} as never,
      driver: {} as never,
      tabId: 1 as never,
      modelId: "claude-sonnet-4-6",
      task: "t",
      systemPrompt: "s",
      maxSteps: 10,
    });

    expect(captured.toModelOutput).toBeTypeOf("function");
    const out = captured.toModelOutput!({
      output: { imageDataUrl: "data:image/png;base64,QUJD" },
    });
    expect(out).toEqual({
      type: "content",
      value: [{ type: "image-data", data: "QUJD", mediaType: "image/png" }],
    });
  });

  it("falls back to a JSON output when no image is present (avoids AI_InvalidPromptError)", () => {
    const out = captured.toModelOutput!({ output: { note: "no image" } });
    expect(out).toEqual({ type: "json", value: { note: "no image" } });
  });
});
