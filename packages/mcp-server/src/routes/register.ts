import type { ClientRegistry } from "../oauth/clients";

export interface RegisterRequestBody {
  client_name?: string;
  redirect_uris?: string[];
}

export interface RegisterResponse {
  status: number;
  body: Record<string, unknown>;
}

export function handleRegister(
  body: RegisterRequestBody,
  clients: ClientRegistry,
): RegisterResponse {
  const result = clients.register({
    client_name: body.client_name,
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
  });
  if (!result.ok) {
    return {
      status: 400,
      body: { error: result.reason, error_description: "registration rejected" },
    };
  }
  return {
    status: 201,
    body: {
      client_id: result.client.client_id,
      client_name: result.client.client_name,
      redirect_uris: result.client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
  };
}
