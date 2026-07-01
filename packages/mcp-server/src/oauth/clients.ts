import { randomBytes } from "node:crypto";

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  registered_at: number;
}

export type RegisterResult =
  | { ok: true; client: RegisteredClient }
  | { ok: false; reason: "invalid_redirect_uri" | "invalid_client_metadata" };

export interface ClientRegistry {
  register(input: { client_name?: string; redirect_uris: string[] }): RegisterResult;
  get(client_id: string): RegisteredClient | undefined;
}

export function createClientRegistry(): ClientRegistry {
  const clients = new Map<string, RegisteredClient>();
  return {
    register({ client_name, redirect_uris }) {
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return { ok: false, reason: "invalid_redirect_uri" };
      }
      const client_id = randomBytes(12).toString("base64url");
      const client: RegisteredClient = {
        client_id,
        client_name,
        redirect_uris,
        registered_at: Date.now(),
      };
      clients.set(client_id, client);
      return { ok: true, client };
    },
    get(client_id) {
      return clients.get(client_id);
    },
  };
}
