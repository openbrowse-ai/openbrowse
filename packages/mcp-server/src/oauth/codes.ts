import { randomBytes } from "node:crypto";

export interface CodeEntry {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  state: string;
  createdAt: number;
  used: boolean;
}

export type RedeemResult =
  | { ok: true; entry: CodeEntry }
  | {
      ok: false;
      reason:
        | "code_not_found"
        | "already_used"
        | "expired"
        | "client_id_mismatch"
        | "redirect_uri_mismatch";
    };

const CODE_TTL_MS = 5 * 60 * 1000;

export interface CodeStore {
  issue(params: Omit<CodeEntry, "code" | "createdAt" | "used">): string;
  redeem(code: string, params: { client_id: string; redirect_uri: string }): RedeemResult;
}

export function createCodeStore(): CodeStore {
  const store = new Map<string, CodeEntry>();
  return {
    issue(params) {
      const code = randomBytes(24).toString("base64url");
      store.set(code, { ...params, code, createdAt: Date.now(), used: false });
      return code;
    },
    redeem(code, { client_id, redirect_uri }) {
      const entry = store.get(code);
      if (!entry) return { ok: false, reason: "code_not_found" };
      if (entry.used) return { ok: false, reason: "already_used" };
      if (Date.now() - entry.createdAt > CODE_TTL_MS) return { ok: false, reason: "expired" };
      if (entry.client_id !== client_id) return { ok: false, reason: "client_id_mismatch" };
      if (entry.redirect_uri !== redirect_uri)
        return { ok: false, reason: "redirect_uri_mismatch" };
      entry.used = true;
      return { ok: true, entry };
    },
  };
}
