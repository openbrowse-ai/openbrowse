// apps/extension/src/lib/artifacts/__tests__/base64-roundtrip.test.ts
import { describe, it, expect } from "vitest";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../base64";
import { BRIDGE_SHIM_SOURCE } from "@/entrypoints/artifact/bridge-shim";

function bytes(arr: number[]): ArrayBuffer {
  return new Uint8Array(arr).buffer;
}

describe("base64 module", () => {
  it("round-trips text", () => {
    const buf = new TextEncoder().encode("hello, 世界 — RSS <item>").buffer;
    const out = base64ToArrayBuffer(arrayBufferToBase64(buf));
    expect(new TextDecoder().decode(out)).toBe("hello, 世界 — RSS <item>");
  });

  it("round-trips arbitrary binary including high bytes and NUL", () => {
    const buf = bytes([0, 1, 2, 127, 128, 200, 254, 255, 0, 0]);
    const out = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(buf)));
    expect(Array.from(out)).toEqual([0, 1, 2, 127, 128, 200, 254, 255, 0, 0]);
  });

  it("round-trips an empty buffer", () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe("");
    expect(base64ToArrayBuffer("").byteLength).toBe(0);
  });

  it("handles a large body without a call-stack overflow (chunking)", () => {
    // > the 0x8000 chunk size, to exercise the chunked fromCharCode loop.
    const n = 200_000;
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = i % 256;
    const out = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(u8.buffer)));
    expect(out.length).toBe(n);
    expect(out[0]).toBe(0);
    expect(out[n - 1]).toBe((n - 1) % 256);
  });
});

describe("bridge shim base64 mirror", () => {
  // The shim cannot import; it inlines b64FromBuf/bufFromB64. Verify the inline
  // copies actually round-trip identically to the module by executing them.
  function extractShimFns() {
    // Pull the two function bodies out of the shim source and eval them in a
    // throwaway scope alongside btoa/atob.
    const src = BRIDGE_SHIM_SOURCE;
    expect(src).toContain("function b64FromBuf");
    expect(src).toContain("function bufFromB64");
    const start = src.indexOf("function b64FromBuf");
    const end = src.indexOf("function bufFromB64");
    const b64FromBufSrc = src.slice(start, end);
    // bufFromB64 ends at the next blank-comment block; grab a generous slice.
    const after = src.slice(end);
    const bufFromB64Src = after.slice(0, after.indexOf("\n\n") >= 0 ? after.indexOf("\n\n") : after.length);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
    const factory = new Function(
      "btoa",
      "atob",
      `${b64FromBufSrc}\n${bufFromB64Src}\nreturn { b64FromBuf: b64FromBuf, bufFromB64: bufFromB64 };`,
    ) as (b: typeof btoa, a: typeof atob) => {
      b64FromBuf: (buf: ArrayBuffer) => string;
      bufFromB64: (s: string) => ArrayBuffer;
    };
    return factory(btoa, atob);
  }

  it("shim b64FromBuf matches the module encoder", () => {
    const { b64FromBuf } = extractShimFns();
    const buf = bytes([0, 1, 200, 255, 17]);
    expect(b64FromBuf(buf)).toBe(arrayBufferToBase64(buf));
  });

  it("shim bufFromB64 round-trips binary identically", () => {
    const { b64FromBuf, bufFromB64 } = extractShimFns();
    const buf = bytes([5, 6, 7, 250, 0, 128]);
    const out = new Uint8Array(bufFromB64(b64FromBuf(buf)));
    expect(Array.from(out)).toEqual([5, 6, 7, 250, 0, 128]);
  });
});
