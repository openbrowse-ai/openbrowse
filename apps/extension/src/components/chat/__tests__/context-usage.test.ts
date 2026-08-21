import { describe, expect, it } from "vitest";
import {
  formatTokens,
  formatCount,
  formatUsagePercent,
  formatCost,
  formatDateTime,
  resolveModelNames,
  resolveModelsLabel,
  usagePercentValue,
} from "../ContextUsage";

// Compute expected strings with the SAME runtime locale formatters the
// component uses, so number/currency assertions are stable regardless of the
// CI locale.
const numFmt = new Intl.NumberFormat(undefined);
const usdFmt = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

describe("ContextUsage formatters", () => {
  it("formats token counts with grouping", () => {
    expect(formatTokens(53_731)).toBe(numFmt.format(53_731));
    expect(formatTokens(0)).toBe(numFmt.format(0));
    expect(formatTokens(842)).toBe(numFmt.format(842));
  });

  it("formats usage percent, guarding divide-by-zero", () => {
    expect(formatUsagePercent(10_000, 200_000)).toBe("5%");
    expect(formatUsagePercent(0, 200_000)).toBe("0%");
    expect(formatUsagePercent(1_000, 0)).toBe("0%");
    // rounds to nearest integer
    expect(formatUsagePercent(7_500, 200_000)).toBe("4%");
    // Defensive clamp. Callers now pass INPUT tokens, which can't exceed the
    // window the provider accepted them into, so this should be unreachable
    // in practice — but the value drives an SVG arc, so it must stay bounded.
    expect(formatUsagePercent(250_000, 200_000)).toBe("100%");
  });

  it("computes the numeric usage percent for the ring", () => {
    expect(usagePercentValue(10_000, 200_000)).toBe(5);
    expect(usagePercentValue(0, 200_000)).toBe(0);
    expect(usagePercentValue(1_000, 0)).toBe(0);
    // rounds to nearest integer
    expect(usagePercentValue(7_500, 200_000)).toBe(4);
    // defensive clamp — see above
    expect(usagePercentValue(250_000, 200_000)).toBe(100);
  });

  it("formats counts with grouping", () => {
    expect(formatCount(2)).toBe(numFmt.format(2));
    expect(formatCount(1_234)).toBe(numFmt.format(1_234));
  });

  it("formats cost as USD currency", () => {
    expect(formatCost(73.48)).toBe(usdFmt.format(73.48));
    expect(formatCost(0)).toBe(usdFmt.format(0));
    expect(formatCost(1.5)).toBe(usdFmt.format(1.5));
    // A positive sub-cent cost never reads as free (our own sentinel string).
    expect(formatCost(0.0003)).toBe("<$0.01");
    expect(formatCost(0.004)).toBe("<$0.01");
    // At/above half a cent it rounds normally.
    expect(formatCost(0.005)).toBe(usdFmt.format(0.005));
  });

  it("formats a date+time, returning empty string for falsy input", () => {
    expect(formatDateTime(0)).toBe("");
    // A real timestamp produces a non-empty localized string containing the year.
    const formatted = formatDateTime(Date.UTC(2026, 4, 26, 18, 23));
    expect(formatted).not.toBe("");
    expect(formatted).toContain("2026");
  });

  it("resolves model names, falling back to raw segments", () => {
    // Empty id → placeholder dashes.
    expect(resolveModelNames("")).toEqual({
      providerName: "—",
      modelName: "—",
    });
    // Unknown qualified id → raw provider + model segments preserved.
    expect(resolveModelNames("madeup:some-model-x")).toEqual({
      providerName: "madeup",
      modelName: "some-model-x",
    });
    // Model id containing extra colons is rejoined for the model segment.
    expect(resolveModelNames("madeup:a:b:c")).toEqual({
      providerName: "madeup",
      modelName: "a:b:c",
    });
    // Bare id with no provider segment → used as the model name.
    expect(resolveModelNames("bare-model")).toEqual({
      providerName: "bare-model",
      modelName: "bare-model",
    });
  });

  it("resolves a combined label across all models used", () => {
    // Empty list + no latest → placeholder dashes.
    expect(resolveModelsLabel([], "")).toEqual({
      providerLabel: "—",
      modelLabel: "—",
    });
    // Empty list falls back to the single latest model id.
    expect(resolveModelsLabel(undefined, "p1:model-a")).toEqual({
      providerLabel: "p1",
      modelLabel: "model-a",
    });
    // Multiple models across distinct providers — joined in order.
    expect(
      resolveModelsLabel(["p1:model-a", "p2:model-b"], "p2:model-b"),
    ).toEqual({
      providerLabel: "p1, p2",
      modelLabel: "model-a, model-b",
    });
    // Two models from the SAME provider — provider listed once, both models shown.
    expect(
      resolveModelsLabel(["p1:model-a", "p1:model-b"], "p1:model-b"),
    ).toEqual({
      providerLabel: "p1",
      modelLabel: "model-a, model-b",
    });
  });
});
