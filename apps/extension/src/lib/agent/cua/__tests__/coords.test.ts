import { describe, expect, it } from "vitest";
import { computeDisplay, mapAnthropicCoord } from "../coords";

describe("computeDisplay", () => {
  it("uses the viewport as-is when within the max width", () => {
    const d = computeDisplay({ cssWidth: 1000, cssHeight: 800, maxWidth: 1280 });
    expect(d).toEqual({ displayWidth: 1000, displayHeight: 800, downscale: 1 });
  });

  it("downscales proportionally when wider than max", () => {
    const d = computeDisplay({ cssWidth: 2560, cssHeight: 1440, maxWidth: 1280 });
    expect(d.displayWidth).toBe(1280);
    expect(d.displayHeight).toBe(720);
    expect(d.downscale).toBeCloseTo(0.5, 5);
  });
});

describe("mapAnthropicCoord", () => {
  it("returns identity CSS coords when downscale is 1", () => {
    expect(mapAnthropicCoord(100, 200, 1)).toEqual({ x: 100, y: 200 });
  });

  it("recovers CSS coords from downscaled model coords", () => {
    // model saw a 0.5x image, so a model coord of 640 == 1280 css px
    expect(mapAnthropicCoord(640, 360, 0.5)).toEqual({ x: 1280, y: 720 });
  });
});
