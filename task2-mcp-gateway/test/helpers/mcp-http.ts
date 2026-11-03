export const ACCEPT_MCP = 'application/json, text/event-stream';

export interface RpcResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

// Raw JSON-RPC over HTTP, so tests see exact status codes and bodies (the SDK client hides them).
export async function postRpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: { raw?: boolean; method?: string } = {},
): Promise<RpcResponse> {
  const response = await fetch(url, {
    method: options.method ?? 'POST',
    headers: { accept: ACCEPT_MCP, 'content-type': 'application/json', ...headers },
    ...(options.method === undefined || options.method === 'POST'
      ? { body: options.raw ? (body as string) : JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
