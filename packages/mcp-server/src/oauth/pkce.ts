import { createHash } from "node:crypto";

export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}
