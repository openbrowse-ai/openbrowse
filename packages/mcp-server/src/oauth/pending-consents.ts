export interface PendingConsent {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  state: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

export interface PendingConsents {
  create(input: Omit<PendingConsent, "createdAt">): PendingConsent;
  find(state: string): PendingConsent | undefined;
  consume(state: string): void;
  sweep(): void;
}

export function createPendingConsents(): PendingConsents {
  const map = new Map<string, PendingConsent>();
  return {
    create(input) {
      const entry: PendingConsent = { ...input, createdAt: Date.now() };
      map.set(entry.state, entry);
      return entry;
    },
    find(state) {
      return map.get(state);
    },
    consume(state) {
      map.delete(state);
    },
    sweep() {
      const now = Date.now();
      for (const [state, entry] of map.entries()) {
        if (now - entry.createdAt > TTL_MS) map.delete(state);
      }
    },
  };
}
