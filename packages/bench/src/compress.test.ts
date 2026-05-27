/**
 * Tests for `compress.ts` — round-trip compression with zstd preferred,
 * gzip as a fallback (or explicit override).
 */

import { describe, expect, it } from "vitest";
import { compress, decompress, type CompressionAlgo } from "./compress";

const SAMPLE = Buffer.from(
  JSON.stringify(
    Array.from({ length: 200 }, (_, i) => ({
      step: i,
      tool: "click",
      input: { selector: `[data-id="${i}"]` },
      output: { ok: true, ts: 1700000000 + i },
    })),
  ),
  "utf-8",
);

describe("compress / decompress (zstd default)", () => {
  it("round-trips arbitrary buffers", () => {
    const { algo, data } = compress(SAMPLE);

    const restored = decompress(data, algo);

    expect(restored.equals(SAMPLE)).toBe(true);
  });

  it("defaults to zstd", () => {
    const { algo } = compress(SAMPLE);

    expect(algo).toBe("zstd");
  });

  it("produces meaningfully smaller output than the input", () => {
    const { data } = compress(SAMPLE);

    expect(data.byteLength).toBeLessThan(SAMPLE.byteLength);
  });
});

describe("compress / decompress (gzip override)", () => {
  it("respects an explicit gzip override", () => {
    const { algo, data } = compress(SAMPLE, { algo: "gzip" });

    expect(algo).toBe("gzip");
    expect(decompress(data, algo).equals(SAMPLE)).toBe(true);
  });
});

describe("decompress error paths", () => {
  it("throws on an unknown algo", () => {
    const { data } = compress(SAMPLE);

    expect(() => decompress(data, "brotli" as CompressionAlgo)).toThrow(
      /unknown compression algo/i,
    );
  });

  it("throws when bytes don't match the declared algo", () => {
    const { data: zstdBytes } = compress(SAMPLE, { algo: "zstd" });

    expect(() => decompress(zstdBytes, "gzip")).toThrow();
  });
});
