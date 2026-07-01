import { sign, verify, KeyObject } from "node:crypto";

export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id?: string;
  client_name?: string;
  scope?: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

export type JwtVerifyResult =
  | { valid: true; payload: JwtClaims }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_audience" | "verify_threw" };

function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function mintJwt(privateKey: KeyObject, kid: string, payload: JwtClaims): string {
  const header = { alg: "EdDSA", typ: "JWT", kid };
  const encHeader = b64u(Buffer.from(JSON.stringify(header)));
  const encPayload = b64u(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64u(signature)}`;
}

export function verifyJwt(
  token: string,
  publicKey: KeyObject,
  opts: { audience: string },
): JwtVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [encHeader, encPayload, encSig] = parts;
  const signingInput = `${encHeader}.${encPayload}`;
  try {
    const ok = verify(null, Buffer.from(signingInput), publicKey, b64uDecode(encSig));
    if (!ok) return { valid: false, reason: "bad_signature" };
    const payload = JSON.parse(b64uDecode(encPayload).toString("utf8")) as JwtClaims;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, reason: "expired" };
    }
    if (payload.aud !== opts.audience) {
      return { valid: false, reason: "wrong_audience" };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "verify_threw" };
  }
}
