import { describe, expect, it } from "vitest";
import { anthropicToolSpec, decodeAnthropicAction } from "../anthropic";

describe("anthropicToolSpec", () => {
  it("maps Sonnet 4.6 to computer_20251124 + 2025-11-24 beta", () => {
    const spec = anthropicToolSpec("claude-sonnet-4-6");
    expect(spec.toolVersion).toBe("computer_20251124");
    expect(spec.beta).toBe("computer-use-2025-11-24");
    expect(spec.enableZoom).toBe(true);
  });

  it("maps Sonnet 4.5 to computer_20250124 + 2025-01-24 beta", () => {
    const spec = anthropicToolSpec("claude-sonnet-4-5");
    expect(spec.toolVersion).toBe("computer_20250124");
    expect(spec.beta).toBe("computer-use-2025-01-24");
  });

  it("enables zoom for new-gen models only", () => {
    expect(anthropicToolSpec("claude-sonnet-4-6").enableZoom).toBe(true);
    expect(anthropicToolSpec("claude-sonnet-4-5").enableZoom).toBe(false);
  });

  it("maps gateway-form ids (anthropic/ prefix, dot versions) the same as direct", () => {
    // Sonnet 4.6 via gateway → new-gen tool + beta
    const newGen = anthropicToolSpec("anthropic/claude-sonnet-4.6");
    expect(newGen.toolVersion).toBe("computer_20251124");
    expect(newGen.beta).toBe("computer-use-2025-11-24");
    // Opus 4.5/4.8 via gateway → new-gen
    expect(anthropicToolSpec("anthropic/claude-opus-4.5").toolVersion).toBe(
      "computer_20251124",
    );
    expect(anthropicToolSpec("anthropic/claude-opus-4.8").toolVersion).toBe(
      "computer_20251124",
    );
    // Sonnet 4.5 via gateway → old-gen
    const oldGen = anthropicToolSpec("anthropic/claude-sonnet-4.5");
    expect(oldGen.toolVersion).toBe("computer_20250124");
    expect(oldGen.beta).toBe("computer-use-2025-01-24");
  });
});

describe("decodeAnthropicAction", () => {
  const ds = 1; // downscale = identity

  it("decodes left_click", () => {
    const a = decodeAnthropicAction({ action: "left_click", coordinate: [100, 200] }, ds);
    expect(a).toEqual({ kind: "click", x: 100, y: 200, button: "left", clickCount: 1 });
  });

  it("decodes double_click", () => {
    const a = decodeAnthropicAction({ action: "double_click", coordinate: [10, 20] }, ds);
    expect(a).toMatchObject({ kind: "click", clickCount: 2 });
  });

  it("decodes type", () => {
    expect(decodeAnthropicAction({ action: "type", text: "hello" }, ds)).toEqual({
      kind: "type",
      text: "hello",
    });
  });

  it("decodes key combo into keys array", () => {
    expect(decodeAnthropicAction({ action: "key", text: "ctrl+s" }, ds)).toEqual({
      kind: "key",
      keys: ["ctrl", "s"],
    });
  });

  it("decodes scroll with direction + amount into deltas", () => {
    const a = decodeAnthropicAction(
      { action: "scroll", coordinate: [5, 5], scroll_direction: "down", scroll_amount: 3 },
      ds,
    );
    expect(a).toMatchObject({ kind: "scroll", x: 5, y: 5, deltaX: 0 });
    expect((a as { deltaY: number }).deltaY).toBeGreaterThan(0);
  });

  it("decodes screenshot", () => {
    expect(decodeAnthropicAction({ action: "screenshot" }, ds)).toEqual({ kind: "screenshot" });
  });

  it("applies the downscale factor to coordinates", () => {
    const a = decodeAnthropicAction({ action: "left_click", coordinate: [640, 360] }, 0.5);
    expect(a).toMatchObject({ kind: "click", x: 1280, y: 720 });
  });

  it("decodes left_click with a modifier from text", () => {
    const a = decodeAnthropicAction({ action: "left_click", coordinate: [10, 20], text: "ctrl" }, ds);
    expect(a).toMatchObject({ kind: "click", x: 10, y: 20, button: "left", clickCount: 1, modifiers: ["ctrl"] });
  });

  it("decodes left_click_drag into a drag action", () => {
    const a = decodeAnthropicAction(
      { action: "left_click_drag", start_coordinate: [5, 6], coordinate: [50, 60] },
      ds,
    );
    expect(a).toEqual({ kind: "drag", x: 5, y: 6, toX: 50, toY: 60 });
  });

  it("decodes left_mouse_down / left_mouse_up with mapped coords", () => {
    // mapAnthropicCoord divides by downscale: [100,200] / 0.5 → {200,400}.
    expect(decodeAnthropicAction({ action: "left_mouse_down", coordinate: [100, 200] }, 0.5)).toEqual({ kind: "mouseDown", x: 200, y: 400 });
    expect(decodeAnthropicAction({ action: "left_mouse_up", coordinate: [100, 200] }, 0.5)).toEqual({ kind: "mouseUp", x: 200, y: 400 });
  });

  it("decodes hold_key into keys + ms", () => {
    expect(decodeAnthropicAction({ action: "hold_key", text: "ctrl+a", duration: 2 }, 1)).toEqual({ kind: "holdKey", keys: ["ctrl", "a"], ms: 2000 });
  });

  it("decodes zoom region verbatim in declared coords (no downscale applied)", () => {
    expect(decodeAnthropicAction({ action: "zoom", region: [10, 20, 110, 220] }, 0.5)).toEqual({ kind: "zoom", x1: 10, y1: 20, x2: 110, y2: 220 });
  });
});
