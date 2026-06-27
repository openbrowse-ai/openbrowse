// apps/extension/src/lib/artifacts/base64.ts
//
// Brokered fetch carries the request/response body across
// chrome.runtime.sendMessage, which serializes messages as JSON. JSON does NOT
// preserve ArrayBuffer/TypedArray (an ArrayBuffer becomes `{}`, a Uint8Array
// becomes a `{ "0": .., "1": .. }` object). So binary bodies are base64-encoded
// for transit and decoded on the far side.
//
// These helpers are also mirrored inline in BRIDGE_SHIM_SOURCE (the shim cannot
// import); base64-roundtrip.test.ts asserts the two stay in agreement.

/** Encode an ArrayBuffer to a base64 string (chunked to avoid call-stack limits). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000; // 32k chars per String.fromCharCode call
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

/** Decode a base64 string back to an ArrayBuffer. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
