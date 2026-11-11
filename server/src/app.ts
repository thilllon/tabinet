import { withCors } from './cors.js';
import type { VerifyGoogleToken } from './google-auth.js';
import type { Store } from './store.js';
import { bearerToken, hashToken, mintToken, TOKEN_TTL_MS } from './tokens.js';
import type { StoredRecord, User } from './types.js';
import {
  MAX_BODY_BYTES,
  parseAccessToken,
  parseKeySetup,
  parseRecordsBody,
  parseRecordsQuery,
} from './validation.js';

/** Everything the router reaches outside itself, injected so tests run without network. */
export interface Deps {
  store: Store;
  verifyGoogleToken: VerifyGoogleToken;
  /** Milliseconds since the epoch. */
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
  /** Origins answered with CORS headers, e.g. `chrome-extension://<id>`. */
  allowedOrigins: readonly string[];
}

type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'key_exists'
  | 'payload_too_large'
  | 'internal';

interface Context {
  request: Request;
  url: URL;
  deps: Deps;
}

interface AuthedContext extends Context {
  user: User;
  tokenHash: string;
}

type Handler = (ctx: Context) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function error(status: number, code: ErrorCode): Response {
  return json(status, { error: code });
}

function noContent(status = 204): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

// Thrown by readJson for a body over MAX_BODY_BYTES; handle() answers it with a 413.
class PayloadTooLargeError extends Error {
  override name = 'PayloadTooLargeError';
}

/** The parsed JSON body, or undefined when it is not JSON at all. Throws over MAX_BODY_BYTES. */
async function readJson(request: Request): Promise<unknown> {
  // Content-Length first, so an honest oversized request is refused without reading it.
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Wraps a handler that needs a signed-in caller: a missing, unknown or expired token is a 401.
function authed(handler: (ctx: AuthedContext) => Promise<Response>): Handler {
  return async (ctx) => {
    const token = bearerToken(ctx.request.headers.get('Authorization'));
    if (token === null) {
      return error(401, 'unauthorized');
    }
    const tokenHash = hashToken(token);
    const user = await ctx.deps.store.findUserByToken(tokenHash, ctx.deps.now());
    if (user === null) {
      return error(401, 'unauthorized');
    }
    return handler({ ...ctx, user, tokenHash });
  };
}

async function signInWithGoogle({ request, deps }: Context): Promise<Response> {
  const accessToken = parseAccessToken(await readJson(request));
  if (accessToken === null) {
    return error(400, 'bad_request');
  }
  const identity = await deps.verifyGoogleToken(accessToken);
  if (identity === null) {
    return error(401, 'unauthorized');
  }
  const user = await deps.store.upsertUser(identity.sub, identity.email);
  const token = mintToken(deps.randomBytes);
  const now = deps.now();
  const expiresAt = now + TOKEN_TTL_MS;
  await deps.store.createToken(hashToken(token), user.id, expiresAt, now);
  return json(200, { token, expiresAt, email: user.email, keySetup: user.keySetup });
}

const logout = authed(async ({ deps, tokenHash }) => {
  await deps.store.deleteToken(tokenHash);
  return noContent();
});

const me = authed(async ({ user }) => json(200, { email: user.email, keySetup: user.keySetup }));

const putKeys = authed(async ({ request, deps, user }) => {
  const keySetup = parseKeySetup(await readJson(request));
  if (keySetup === null) {
    return error(400, 'bad_request');
  }
  // Set once: a second setup would make every record encrypted under the first key unreadable.
  return (await deps.store.setKeySetup(user.id, keySetup))
    ? noContent(201)
    : error(409, 'key_exists');
});

const getRecords = authed(async ({ url, deps, user }) => {
  const query = parseRecordsQuery(url.searchParams);
  if (query === null) {
    return error(400, 'bad_request');
  }
  // One extra row says whether there is more without a second query.
  const rows = await deps.store.listRecords(user.id, query.since, query.limit + 1, query.kinds);
  const hasMore = rows.length > query.limit;
  const records: StoredRecord[] = hasMore ? rows.slice(0, query.limit) : rows;
  const next = records.length > 0 ? records[records.length - 1].seq : query.since;
  return json(200, { records, next, hasMore });
});

const postRecords = authed(async ({ request, deps, user }) => {
  const records = parseRecordsBody(await readJson(request));
  if (records === null) {
    return error(400, 'bad_request');
  }
  const results = [];
  // In order, one statement each: a later record with the same (kind, id) sees the earlier one.
  for (const record of records) {
    const result = await deps.store.applyRecord(user.id, record);
    const { kind, id } = record;
    if (result.status === 'applied') {
      results.push({ kind, id, status: 'applied', seq: result.seq });
    } else if (result.status === 'stale') {
      results.push({ kind, id, status: 'stale', current: result.current });
    } else {
      // Over a per-account limit: nothing stored, the client keeps it and says so.
      results.push({ kind, id, status: 'rejected', reason: result.reason });
    }
  }
  return json(200, { results });
});

const deleteAccount = authed(async ({ deps, user }) => {
  await deps.store.deleteUser(user.id);
  return noContent();
});

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  '/v1/auth/google': { POST: signInWithGoogle },
  '/v1/auth/logout': { POST: logout },
  '/v1/me': { GET: me },
  '/v1/keys': { PUT: putKeys },
  '/v1/records': { GET: getRecords, POST: postRecords },
  '/v1/account': { DELETE: deleteAccount },
};

async function route(request: Request, url: URL, deps: Deps): Promise<Response> {
  const methods = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
  if (methods === undefined) {
    return error(404, 'not_found');
  }
  const handler = methods[request.method];
  if (handler === undefined) {
    const response = error(405, 'method_not_allowed');
    response.headers.set('Allow', Object.keys(methods).join(', '));
    return response;
  }
  return handler({ request, url, deps });
}

/** The whole API: one web-standard handler, used by the Vercel function and by the tests. */
export async function handle(request: Request, deps: Deps): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    return withCors(noContent(), origin, deps.allowedOrigins, true);
  }
  let response: Response;
  try {
    response = await route(request, new URL(request.url), deps);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return withCors(error(413, 'payload_too_large'), origin, deps.allowedOrigins, false);
    }
    // The name only: a message or stack could carry a token, a hash or a record's ciphertext.
    console.error(
      'tabinet-server: request failed',
      request.method,
      err instanceof Error ? err.name : typeof err,
    );
    response = error(500, 'internal');
  }
  return withCors(response, origin, deps.allowedOrigins, false);
}
