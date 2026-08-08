import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/registry/providers/types";
import {
  familyOf,
  formatContextWindow,
  groupLocalModels,
  isBaseDownloaded,
  splitQuant,
} from "../local-model-catalog";

function m(id: string, caps: ModelDefinition["capabilities"] = ["chat"]): ModelDefinition {
  return { id, name: id, capabilities: caps };
}

describe("splitQuant", () => {
  it("strips the MLC suffix and normalizes the quant tag", () => {
    expect(splitQuant("Llama-3.2-3B-Instruct-q4f16_1-MLC")).toEqual({
      base: "Llama-3.2-3B-Instruct",
      quant: "q4f16",
    });
    expect(splitQuant("Qwen2.5-7B-Instruct-q4f32_1-MLC")).toEqual({
      base: "Qwen2.5-7B-Instruct",
      quant: "q4f32",
    });
    expect(splitQuant("Phi-3-mini-q0f16-MLC")).toEqual({
      base: "Phi-3-mini",
      quant: "q0f16",
    });
  });

  it("returns an empty quant when the id has none", () => {
    expect(splitQuant("Some-Model")).toEqual({ base: "Some-Model", quant: "" });
  });
});

describe("familyOf", () => {
  it("uses the leading dash-segment", () => {
    expect(familyOf("Llama-3.2-3B-Instruct")).toBe("Llama");
    expect(familyOf("Qwen2.5-7B-Instruct")).toBe("Qwen2.5");
    expect(familyOf("DeepSeek-R1-Distill-Llama-8B")).toBe("DeepSeek");
  });
});

describe("groupLocalModels", () => {
  it("collapses quant variants under one base and groups by family", () => {
    const groups = groupLocalModels([
      m("Llama-3.2-3B-Instruct-q4f32_1-MLC"),
      m("Llama-3.2-3B-Instruct-q4f16_1-MLC"),
      m("Llama-3.1-8B-Instruct-q4f16_1-MLC"),
      m("Qwen2.5-7B-Instruct-q4f16_1-MLC"),
    ]);
    expect(groups.map((g) => g.family)).toEqual(["Llama", "Qwen2.5"]);
    const llama = groups[0];
    expect(llama.bases.map((b) => b.baseKey)).toEqual([
      "Llama-3.1-8B-Instruct",
      "Llama-3.2-3B-Instruct",
    ]);
    // recommended (q4f16) sorted ahead of q4f32
    const threeB = llama.bases[1];
    expect(threeB.variants.map((v) => v.quant)).toEqual(["q4f16", "q4f32"]);
  });

  it("unions capabilities across variants", () => {
    const groups = groupLocalModels([
      m("Hermes-3-Llama-3.1-8B-q4f16_1-MLC", ["chat", "tools"]),
      m("Hermes-3-Llama-3.1-8B-q4f32_1-MLC", ["chat", "tools"]),
    ]);
    expect(groups[0].bases[0].capabilities).toEqual(["chat", "tools"]);
  });
});

describe("isBaseDownloaded", () => {
  it("is true when any variant is downloaded", () => {
    const [group] = groupLocalModels([
      m("Llama-3.2-3B-Instruct-q4f16_1-MLC"),
      m("Llama-3.2-3B-Instruct-q4f32_1-MLC"),
    ]);
    const base = group.bases[0];
    expect(isBaseDownloaded(base, ["Llama-3.2-3B-Instruct-q4f32_1-MLC"])).toBe(true);
    expect(isBaseDownloaded(base, ["something-else"])).toBe(false);
  });
});

describe("formatContextWindow", () => {
  it("renders compact K labels", () => {
    expect(formatContextWindow(131072)).toBe("128K");
    expect(formatContextWindow(32768)).toBe("32K");
    expect(formatContextWindow(8192)).toBe("8K");
    expect(formatContextWindow(4096)).toBe("4K");
    expect(formatContextWindow(512)).toBe("512");
  });
});
