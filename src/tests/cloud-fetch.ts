/**
 * A stand-in for the sync server (GitHub issue #165) in cloud tests: answers each request from a
 * list of canned responses, and records what was asked.
 */

export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = Response | Error | ((request: SeenRequest) => Response | Error);

export interface FakeFetch {
  fetch: typeof fetch;
  requests: SeenRequest[];
}

export function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers the requests in order; one answer left over is reused for every later request. */
export function fakeFetch(...answers: Answer[]): FakeFetch {
  const requests: SeenRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = init?.body;
    const request: SeenRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    };
    requests.push(request);
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === undefined) {
      throw new Error('fakeFetch: no answer left');
    }
    const answer = typeof next === 'function' ? next(request) : next;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { fetch: fetchImpl, requests };
}

// ---------------------------------------------------------------------------
// A sync server with the real records semantics (GitHub issues #165, #170)
// ---------------------------------------------------------------------------

type FakeKind = 'session' | 'settings' | 'notes' | 'image';

/** A record as the fake server keeps it: what was posted, plus its place in the change feed. */
export interface FakeServerRecord {
  kind: FakeKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
  iv: string;
  ciphertext: string;
  seq: number;
}

export interface FakeSyncServer {
  fetch: typeof fetch;
  /** Every request, as for `fakeFetch`. */
  requests: SeenRequest[];
  /** The stored records by `kind:id`. */
  records: Map<string, FakeServerRecord>;
  /** The token every request must present. */
  token: string;
  /** While true every request fails as a network failure would. */
  offline: boolean;
  /** Each `POST /v1/records` body: how many records and how many bytes. */
  posts: { count: number; bytes: number }[];
  /** Replaces a stored record's ciphertext with one that does not decrypt, bumping its `seq`. */
  tamper(kind: FakeKind, id: string): void;
  /** The stored record, if any. */
  record(kind: FakeKind, id: string): FakeServerRecord | undefined;
  /** The most live `image` records the account may hold (the server's `IMAGE_RECORD_LIMIT`). */
  imageLimit: number;
  /** Stores a record as another device's accepted write would, with the next `seq`. */
  inject(record: Omit<FakeServerRecord, 'seq'>): void;
}

/** The server's limits (server/src/validation.ts). */
const SERVER_MAX_RECORDS = 100;
const SERVER_MAX_BODY_BYTES = 4 * 1024 * 1024;
const SERVER_MAX_CIPHERTEXT_CHARS = 1024 * 1024;
const SERVER_DEFAULT_LIMIT = 500;
const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_KINDS: readonly FakeKind[] = ['session', 'settings', 'notes', 'image'];
/** What `GET /v1/records` lists to a client that names no kinds. */
const SERVER_DEFAULT_KINDS: readonly FakeKind[] = ['session', 'settings'];
const SERVER_IMAGE_LIMIT = 100;

function isFakeKind(value: unknown): value is FakeKind {
  return SERVER_KINDS.some((kind) => kind === value);
}

function isPostedRecord(value: unknown): value is Omit<FakeServerRecord, 'seq'> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'ciphertext,deleted,id,iv,kind,updatedAt') {
    return false;
  }
  const { kind, id, updatedAt, deleted, iv, ciphertext } = record;
  if (
    !isFakeKind(kind) ||
    typeof id !== 'string' ||
    !SERVER_ID.test(id) ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    typeof deleted !== 'boolean' ||
    typeof iv !== 'string' ||
    typeof ciphertext !== 'string'
  ) {
    return false;
  }
  // A tombstone carries an iv and a ciphertext like a live record (the deletion is encrypted).
  return iv !== '' && ciphertext !== '' && ciphertext.length <= SERVER_MAX_CIPHERTEXT_CHARS;
}

/**
 * An in-memory sync server shared by any number of simulated devices: bearer token check, `GET
 * /v1/records?since&limit&kinds` paging by `seq` (only session and settings records when no kinds
 * are named), and `POST /v1/records` with the server's limits and its last-writer-wins rule
 * (applied only when `updatedAt` is greater than the stored one; a tie or an older write is
 * `stale` with the current record), and its cap on live screenshots (one more live `image` record
 * is `rejected` with `image_limit`; tombstones always go through). Every applied write takes the
 * next `seq`.
 */
export function fakeSyncServer(token = 'tok'): FakeSyncServer {
  const records = new Map<string, FakeServerRecord>();
  const requests: SeenRequest[] = [];
  const posts: { count: number; bytes: number }[] = [];
  let seq = 0;

  const server: FakeSyncServer = {
    requests,
    records,
    token,
    offline: false,
    posts,
    imageLimit: SERVER_IMAGE_LIMIT,
    tamper(kind, id) {
      const stored = records.get(`${kind}:${id}`);
      if (stored === undefined) {
        throw new Error(`fakeSyncServer: no ${kind} ${id} to tamper with`);
      }
      seq += 1;
      // Valid base64, wrong bytes: AES-GCM refuses it.
      records.set(`${kind}:${id}`, {
        ...stored,
        ciphertext: btoa('not the real ciphertext!'),
        seq,
      });
    },
    record(kind, id) {
      return records.get(`${kind}:${id}`);
    },
    inject(record) {
      seq += 1;
      records.set(`${record.kind}:${record.id}`, { ...record, seq });
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const raw = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({
        url: url.toString(),
        method,
        headers,
        body: raw === undefined ? undefined : JSON.parse(raw),
      });
      if (server.offline) {
        throw new TypeError('Failed to fetch');
      }
      if (headers.authorization !== `Bearer ${server.token}`) {
        return jsonResponse(401, { error: 'unauthorized' });
      }
      if (url.pathname !== '/v1/records') {
        return jsonResponse(404, { error: 'not_found' });
      }
      if (method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? String(SERVER_DEFAULT_LIMIT));
        const kindsParam = url.searchParams.get('kinds');
        const kinds = kindsParam === null ? SERVER_DEFAULT_KINDS : kindsParam.split(',');
        if (
          !Number.isSafeInteger(since) ||
          since < 0 ||
          !(limit >= 1 && limit <= 500) ||
          !kinds.every(isFakeKind)
        ) {
          return jsonResponse(400, { error: 'bad_request' });
        }
        const rows = [...records.values()]
          .filter((record) => record.seq > since && kinds.includes(record.kind))
          .sort((a, b) => a.seq - b.seq);
        const page = rows.slice(0, limit);
        return jsonResponse(200, {
          records: page.map((record) => ({ ...record })),
          next: page.length > 0 ? page[page.length - 1].seq : since,
          hasMore: rows.length > limit,
        });
      }
      if (method !== 'POST' || raw === undefined) {
        return jsonResponse(405, { error: 'method_not_allowed' });
      }
      const bytes = new TextEncoder().encode(raw).length;
      if (bytes > SERVER_MAX_BODY_BYTES) {
        return jsonResponse(413, { error: 'too_large' });
      }
      const body: unknown = JSON.parse(raw);
      const posted =
        typeof body === 'object' && body !== null ? (body as { records?: unknown }).records : null;
      if (
        !Array.isArray(posted) ||
        posted.length > SERVER_MAX_RECORDS ||
        !posted.every(isPostedRecord)
      ) {
        return jsonResponse(400, { error: 'bad_request' });
      }
      posts.push({ count: posted.length, bytes });
      const results = posted.map((record) => {
        const key = `${record.kind}:${record.id}`;
        const stored = records.get(key);
        if (stored !== undefined && record.updatedAt <= stored.updatedAt) {
          return { kind: record.kind, id: record.id, status: 'stale', current: { ...stored } };
        }
        if (
          record.kind === 'image' &&
          !record.deleted &&
          (stored === undefined || stored.deleted)
        ) {
          const live = [...records.values()].filter((r) => r.kind === 'image' && !r.deleted);
          if (live.length >= server.imageLimit) {
            return { kind: record.kind, id: record.id, status: 'rejected', reason: 'image_limit' };
          }
        }
        seq += 1;
        records.set(key, { ...record, seq });
        return { kind: record.kind, id: record.id, status: 'applied', seq };
      });
      return jsonResponse(200, { results });
    },
  };
  return server;
}
