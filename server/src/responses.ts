import type { ErrorCode } from './types.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// Not Hono's c.json(): its Content-Type has no charset, and these headers are part of the contract.
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Exactly `{"error":"<code>"}`. `withBody: false` is the answer to a HEAD. */
export function error(status: number, code: ErrorCode, withBody = true): Response {
  return withBody
    ? json(status, { error: code })
    : new Response(null, { status, headers: JSON_HEADERS });
}

export function noContent(status = 204): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** The NDJSON answer of a pull (spec 4.4). */
export function ndjson(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
