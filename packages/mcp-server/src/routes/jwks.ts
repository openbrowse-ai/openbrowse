import type { KeyObject } from "node:crypto";

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  use: "sig";
  alg: "EdDSA";
  kid: string;
  x: string;
}

export interface JwksResponse {
  keys: Jwk[];
}

export function buildJwks(publicKey: KeyObject, kid: string): JwksResponse {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // Ed25519 SPKI: last 32 bytes are the raw public key
  const raw = der.subarray(der.length - 32);
  return {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        use: "sig",
        alg: "EdDSA",
        kid,
        x: raw.toString("base64url"),
      },
    ],
  };
}
