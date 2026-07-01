export const DEFAULT_PORT = 47821;

export interface Config {
  port: number;
  issuer: string;
  resource: string;
}

export function buildConfig(opts: { port?: number } = {}): Config {
  const port = opts.port ?? DEFAULT_PORT;
  const issuer = `http://localhost:${port}`;
  const resource = `${issuer}/mcp`;
  return { port, issuer, resource };
}

export const SCOPES = [
  "task",
  "read_page",
  "screenshot",
  "list_windows",
  "list_spaces",
  "open_url",
] as const;

export type Scope = (typeof SCOPES)[number];
