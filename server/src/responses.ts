type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'key_exists'
  | 'payload_too_large'
  | 'internal';

// Not Hono's c.json(): its Content-Type has no charset, and these headers are part of the contract.
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function error(status: number, code: ErrorCode): Response {
  return json(status, { error: code });
}

export function noContent(status = 204): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}
