import type { WebSocket } from "ws";

export interface ExtensionSession {
  ws: WebSocket;
  sessionId: string;
  extensionVersion: string;
  capabilities: { tools: string[]; profile: string };
  connectedAt: number;
}

export class SessionRegistry {
  private current: ExtensionSession | null = null;

  hasActiveSession(): boolean {
    return this.current !== null;
  }

  setSession(session: ExtensionSession): void {
    this.current = session;
  }

  clearSession(): void {
    this.current = null;
  }

  getSession(): ExtensionSession | null {
    return this.current;
  }
}
