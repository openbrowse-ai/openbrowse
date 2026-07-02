import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DIR = () => join(process.env.HOME ?? homedir(), ".openbrowse");
const FILE = () => join(DIR(), "clients.json");

/**
 * Cap on stored DCR clients. Oldest-by-`last_used_at` entries are evicted
 * when the cap is exceeded, so a hostile (or merely chatty) host that
 * re-registers on every connection cannot grow the file without bound.
 * 500 clients × ~200 bytes ≈ 100 KB worst case.
 */
const MAX_CLIENTS = 500;

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  registered_at: number;
  /** Updated via `touch()` on successful authorization — drives LRU eviction. */
  last_used_at: number;
}

interface PersistedFile {
  version: 1;
  clients: Record<string, RegisteredClient>;
}

export type RegisterResult =
  | { ok: true; client: RegisteredClient }
  | { ok: false; reason: "invalid_redirect_uri" | "invalid_client_metadata" };

export interface ClientRegistry {
  register(input: { client_name?: string; redirect_uris: string[] }): RegisterResult;
  get(client_id: string): RegisteredClient | undefined;
  /**
   * Mark a client as recently used (updates `last_used_at` and persists).
   * Called on SUCCESSFUL authorization only — failed authorize attempts must
   * not extend a client's LRU lifetime, otherwise an attacker probing with a
   * stolen client_id would keep it alive indefinitely.
   */
  touch(client_id: string): void;
}

function emptyState(): PersistedFile {
  return { version: 1, clients: {} };
}

function load(): PersistedFile {
  const path = FILE();
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedFile;
    // Schema check: unknown versions or malformed shapes fall back to empty
    // rather than crashing the broker at startup. Existing hosts will hit
    // "Unknown client_id" once and re-register via DCR — fail-open on
    // registration, fail-closed on recognition.
    if (parsed?.version !== 1 || typeof parsed.clients !== "object" || parsed.clients === null) {
      console.error(
        `[openbrowse-mcp] ${path} has an unrecognized schema; starting with an empty client registry`,
      );
      return emptyState();
    }
    return parsed;
  } catch {
    console.error(
      `[openbrowse-mcp] ${path} is unreadable or corrupt; starting with an empty client registry`,
    );
    return emptyState();
  }
}

function persist(state: PersistedFile): void {
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const path = FILE();
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  // `mode` on writeFileSync only applies at creation; enforce on every write
  // so a pre-existing file with looser permissions gets tightened.
  chmodSync(path, 0o600);
}

function evictLruIfNeeded(state: PersistedFile): void {
  const entries = Object.entries(state.clients);
  if (entries.length <= MAX_CLIENTS) return;
  entries.sort((a, b) => a[1].last_used_at - b[1].last_used_at);
  const excess = entries.length - MAX_CLIENTS;
  for (let i = 0; i < excess; i++) {
    delete state.clients[entries[i]![0]];
  }
}

/**
 * DCR client registry persisted to `~/.openbrowse/clients.json`.
 *
 * Persistence matters: MCP hosts cache the `client_id` they received from
 * `/register` and reuse it across sessions. If the registry lived only in
 * memory (as it did pre-0.2.1), every broker restart wiped it and hosts hit
 * `Unknown client_id` on their next `/authorize` — the host-visible symptom
 * being a confusing error page in the consent tab.
 *
 * Follows the same storage pattern as `refresh-tokens.ts`: synchronous JSON
 * file under `$HOME/.openbrowse`, dir 0700 / file 0600, single-process
 * access (the broker holds a lock via broker.lock), state mutated in memory
 * and flushed after every mutation.
 */
export function createClientRegistry(): ClientRegistry {
  const state = load();
  return {
    register({ client_name, redirect_uris }) {
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return { ok: false, reason: "invalid_redirect_uri" };
      }
      const client_id = randomBytes(12).toString("base64url");
      const now = Date.now();
      const client: RegisteredClient = {
        client_id,
        client_name,
        redirect_uris,
        registered_at: now,
        last_used_at: now,
      };
      state.clients[client_id] = client;
      evictLruIfNeeded(state);
      persist(state);
      return { ok: true, client };
    },
    get(client_id) {
      return state.clients[client_id];
    },
    touch(client_id) {
      const client = state.clients[client_id];
      if (!client) return;
      client.last_used_at = Date.now();
      persist(state);
    },
  };
}
