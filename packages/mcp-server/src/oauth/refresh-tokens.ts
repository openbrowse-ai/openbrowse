import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;

const FILE = () => join(process.env.HOME ?? homedir(), ".openbrowse", "refresh-tokens.json");

interface PersistedEntry {
  clientId: string;
  scope: string;
  issuedAt: number;
  lastUsedAt: number;
}

interface PersistedFile {
  tokens: Record<string, PersistedEntry>;
}

export type RedeemResult =
  | { ok: true; entry: PersistedEntry; newToken: string }
  | { ok: false; reason: "not_found" | "expired" | "inactive" };

export interface RefreshTokenStore {
  issue(input: { clientId: string; scope: string }): string;
  redeem(token: string): RedeemResult;
  revokeClient(clientId: string): Promise<void>;
}

async function load(): Promise<PersistedFile> {
  const path = FILE();
  if (!existsSync(path)) return { tokens: {} };
  return JSON.parse(readFileSync(path, "utf8")) as PersistedFile;
}

function persist(state: PersistedFile): void {
  const path = FILE();
  mkdirSync(join(process.env.HOME ?? homedir(), ".openbrowse"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function createRefreshTokenStore(): Promise<RefreshTokenStore> {
  const state: PersistedFile = await load();

  return {
    issue({ clientId, scope }) {
      const token = randomBytes(32).toString("base64url");
      state.tokens[token] = { clientId, scope, issuedAt: Date.now(), lastUsedAt: Date.now() };
      persist(state);
      return token;
    },
    redeem(token) {
      const entry = state.tokens[token];
      if (!entry) return { ok: false, reason: "not_found" };
      const now = Date.now();
      if (now - entry.issuedAt > TTL_MS) {
        delete state.tokens[token];
        persist(state);
        return { ok: false, reason: "expired" };
      }
      if (now - entry.lastUsedAt > INACTIVITY_MS) {
        delete state.tokens[token];
        persist(state);
        return { ok: false, reason: "inactive" };
      }
      // Rotate. Preserve the original `issuedAt` so the 30-day absolute TTL
      // is enforced from the FIRST issuance, not from the most recent rotation.
      // Otherwise a host that refreshes within the 90-day inactivity window
      // could keep a refresh token alive forever, bypassing the 30-day cap.
      delete state.tokens[token];
      const newToken = randomBytes(32).toString("base64url");
      const newEntry: PersistedEntry = { ...entry, lastUsedAt: now };
      state.tokens[newToken] = newEntry;
      persist(state);
      return { ok: true, entry: newEntry, newToken };
    },
    async revokeClient(clientId) {
      for (const [tk, e] of Object.entries(state.tokens)) {
        if (e.clientId === clientId) delete state.tokens[tk];
      }
      persist(state);
    },
  };
}
