/**
 * Stand-ins for the sync server in cloud tests. `fakeFetch()` answers from a list of canned
 * responses; `fakeSyncServer()` is an in-memory server that follows protocol v2 (spec section 4)
 * exactly, shared by any number of simulated devices, with hooks to make it lie.
 */
import { POLICY } from '@/constants';
import type { KeyEnvelope, RecordKind, RecordOut, Usage, WriteResult } from '@/types';

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
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** An NDJSON answer whose body arrives in `chunks` (strings or bytes), in order. */
export function ndjsonResponse(chunks: readonly (string | Uint8Array)[], status = 200): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      },
    }),
    { status, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } },
  );
}

function seen(input: RequestInfo | URL, init?: RequestInit): SeenRequest {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const raw = init?.body;
  return {
    url: input instanceof Request ? input.url : String(input),
    method: init?.method ?? 'GET',
    headers,
    body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
  };
}

/** Answers the requests in order; one answer left over is reused for every later request. */
export function fakeFetch(...answers: Answer[]): FakeFetch {
  const requests: SeenRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = seen(input, init);
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
// A v2 sync server
// ---------------------------------------------------------------------------

/** A record as the fake server keeps it. */
export type FakeServerRecord = RecordOut & { storedBytes: number };

export interface FakeKey {
  keyId: string;
  generation: number;
  verifier: string;
  envelope: KeyEnvelope;
}

export interface FakeAccount {
  accountId: string;
  sub: string;
  email: string;
  key: FakeKey | null;
  records: Map<string, FakeServerRecord>;
  lastSeq: number;
}

export type GoogleAnswer = { sub: string; email: string } | 'refused' | 'unavailable';

export interface FakeSyncServer {
  fetch: typeof fetch;
  requests: SeenRequest[];
  /** Accounts by Google sub. */
  accounts: Map<string, FakeAccount>;
  /** Bearer to account id and expiry. */
  tokens: Map<string, { accountId: string; expiresAt: number }>;
  /** While true every request fails as a network failure would. */
  offline: boolean;
  /** Each `POST /v2/records` body: how many records and how many bytes. */
  posts: { count: number; bytes: number }[];
  /** Who a Google access token belongs to. Default: `google:<sub>` is `<sub>@example.com`. */
  google(accessToken: string): GoogleAnswer;
  /** The caps (`POLICY.account.*` unless a test lowers them). */
  storageLimit: number;
  imageLimit: number;
  /** Lines of every stream before they are sent; a test edits them to lie. */
  streamLines?: (lines: string[]) => string[];
  /** Results of every push before they are sent; a test edits them to lie. */
  pushResults?: (results: WriteResult[]) => WriteResult[];
  /** Answers a request instead of the server, when it returns a response. */
  intercept?: (request: SeenRequest) => Response | Error | undefined;
  /** Splits every stream body into chunks of this many bytes (`Infinity`: one per line). */
  chunkBytes: number;
  /** The one account the helpers act on (made by `seedAccount()` or the first sign-in). */
  account(sub?: string): FakeAccount;
  /** An account with a live bearer, without Google. */
  seedAccount(options?: { sub?: string; email?: string; token?: string }): {
    accountId: string;
    token: string;
  };
  /** Sets the account's key directly (as another device's create would). */
  seedKey(key: Omit<FakeKey, 'verifier'> & { verifier?: string }, sub?: string): void;
  /** Stores a record as another device's accepted write would, with the next `seq`. */
  inject(record: Omit<RecordOut, 'seq'>, sub?: string): RecordOut;
  /** Replaces a stored record's ciphertext with one that does not decrypt, bumping its `seq`. */
  tamper(kind: RecordKind, id: string, sub?: string): void;
  record(kind: RecordKind, id: string, sub?: string): FakeServerRecord | undefined;
  usage(sub?: string): Usage;
  now(): number;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const KINDS: readonly RecordKind[] = ['session', 'settings', 'image', 'doc'];

function b64Bytes(text: unknown): number | undefined {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    return undefined;
  }
  try {
    const binary = atob(text);
    return btoa(binary) === text ? binary.length : undefined;
  } catch {
    return undefined;
  }
}

function error(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isEnvelope(value: unknown): value is KeyEnvelope {
  return (
    isObject(value) &&
    exactly(value, ['v', 'generation', 'keyId', 'salt', 'iv', 'wrapped']) &&
    value.v === 2 &&
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    value.generation >= 1 &&
    typeof value.keyId === 'string' &&
    KEY_ID.test(value.keyId) &&
    b64Bytes(value.salt) === 16 &&
    b64Bytes(value.iv) === 12 &&
    b64Bytes(value.wrapped) === 48
  );
}

async function sha256Hex(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storedBytesOf(ciphertext: string): number {
  return Math.max(ciphertext.length, POLICY.record.maxTombstoneChars) + POLICY.record.overheadBytes;
}

function plainRecord(record: FakeServerRecord): RecordOut {
  const { kind, id, updatedAt, deleted, iv, ciphertext, seq } = record;
  return { kind, id, updatedAt, deleted, iv, ciphertext, seq };
}

function jsonOk(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function fakeSyncServer(): FakeSyncServer {
  const requests: SeenRequest[] = [];
  const accounts = new Map<string, FakeAccount>();
  const tokens = new Map<string, { accountId: string; expiresAt: number }>();
  let seq = 0;
  let tokenCount = 0;

  const byId = (accountId: string) =>
    [...accounts.values()].find((account) => account.accountId === accountId);
  const usageOf = (account: FakeAccount): Usage => {
    let bytes = 0;
    let screenshots = 0;
    for (const record of account.records.values()) {
      bytes += record.storedBytes;
      if (record.kind === 'image' && !record.deleted) {
        screenshots += 1;
      }
    }
    return { bytes, screenshots };
  };
  const upsert = (sub: string, email: string): FakeAccount => {
    const existing = accounts.get(sub);
    if (existing !== undefined) {
      existing.email = email;
      return existing;
    }
    const account: FakeAccount = {
      accountId: crypto.randomUUID(),
      sub,
      email,
      key: null,
      records: new Map(),
      lastSeq: 0,
    };
    accounts.set(sub, account);
    return account;
  };
  const issueToken = (
    account: FakeAccount,
    token?: string,
  ): { token: string; expiresAt: number } => {
    tokenCount += 1;
    const value = token ?? `bearer-${tokenCount}-${account.accountId.slice(0, 8)}`;
    const expiresAt = server.now() + POLICY.signIn.tokenLifetimeMs;
    tokens.set(value, { accountId: account.accountId, expiresAt });
    return { token: value, expiresAt };
  };
  const wireKey = (account: FakeAccount) =>
    account.key === null ? null : { keyId: account.key.keyId, generation: account.key.generation };

  const write = (
    account: FakeAccount,
    record: Omit<RecordOut, 'seq'>,
    baseSeq: number | null | undefined,
  ) => {
    const key = `${record.kind}:${record.id}`;
    const old = account.records.get(key);
    if (
      (record.kind === 'doc' && (baseSeq ?? null) !== (old?.seq ?? null)) ||
      (old !== undefined && old.updatedAt >= record.updatedAt)
    ) {
      return 'stale' as const;
    }
    const storedBytes = storedBytesOf(record.ciphertext);
    const usage = usageOf(account);
    const byteDelta = storedBytes - (old?.storedBytes ?? 0);
    const shotDelta =
      record.kind === 'image'
        ? Number(!record.deleted) - Number(old !== undefined && !old.deleted)
        : 0;
    if (record.deleted) {
      if (old === undefined && usage.bytes + byteDelta > server.storageLimit) {
        return 'absent' as const;
      }
    } else {
      if (shotDelta > 0 && usage.screenshots + shotDelta > server.imageLimit) {
        return 'image_limit' as const;
      }
      if (byteDelta > 0 && usage.bytes + byteDelta > server.storageLimit) {
        return 'storage_limit' as const;
      }
    }
    seq += 1;
    account.records.set(key, { ...record, seq, storedBytes });
    account.lastSeq = seq;
    return seq;
  };

  const server: FakeSyncServer = {
    requests,
    accounts,
    tokens,
    offline: false,
    posts: [],
    storageLimit: POLICY.account.storageBytes,
    imageLimit: POLICY.account.screenshots,
    chunkBytes: Infinity,
    now: () => Date.now(),
    google(accessToken) {
      const match = /^google:(.+)$/.exec(accessToken);
      return match === null ? 'refused' : { sub: match[1]!, email: `${match[1]!}@example.com` };
    },
    account(sub) {
      const account = sub === undefined ? [...accounts.values()][0] : accounts.get(sub);
      if (account === undefined) {
        throw new Error('fakeSyncServer: no such account');
      }
      return account;
    },
    seedAccount(options = {}) {
      const sub = options.sub ?? 'person';
      const account = upsert(sub, options.email ?? `${sub}@example.com`);
      return { accountId: account.accountId, token: issueToken(account, options.token).token };
    },
    seedKey(key, sub) {
      server.account(sub).key = { verifier: '0'.repeat(64), ...key };
    },
    inject(record, sub) {
      const account = server.account(sub);
      seq += 1;
      const stored = { ...record, seq, storedBytes: storedBytesOf(record.ciphertext) };
      account.records.set(`${record.kind}:${record.id}`, stored);
      account.lastSeq = seq;
      return plainRecord(stored);
    },
    tamper(kind, id, sub) {
      const account = server.account(sub);
      const stored = account.records.get(`${kind}:${id}`);
      if (stored === undefined) {
        throw new Error(`fakeSyncServer: no ${kind} ${id} to tamper with`);
      }
      seq += 1;
      account.records.set(`${kind}:${id}`, {
        ...stored,
        ciphertext: btoa('not the real ciphertext!'),
        seq,
      });
      account.lastSeq = seq;
    },
    record(kind, id, sub) {
      return accounts.size === 0 ? undefined : server.account(sub).records.get(`${kind}:${id}`);
    },
    usage(sub) {
      return usageOf(server.account(sub));
    },
    fetch: async (input, init) => {
      const request = seen(input, init);
      requests.push(request);
      if (server.offline) {
        throw new TypeError('Failed to fetch');
      }
      const intercepted = server.intercept?.(request);
      if (intercepted instanceof Error) {
        throw intercepted;
      }
      if (intercepted !== undefined) {
        return intercepted;
      }
      return route(request);
    },
  };

  async function identity(request: SeenRequest, account: FakeAccount): Promise<Response | null> {
    const body = request.body;
    if (!isObject(body) || typeof body.accessToken !== 'string' || body.accessToken === '') {
      return error(400, 'bad_request');
    }
    const answer = server.google(body.accessToken);
    if (answer === 'refused') {
      return error(403, 'google_refused');
    }
    if (answer === 'unavailable') {
      return error(503, 'google_unavailable');
    }
    return answer.sub === account.sub ? null : error(403, 'google_account_mismatch');
  }

  function bearer(request: SeenRequest): FakeAccount | null {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    const entry = match === null ? undefined : tokens.get(match[1]!);
    if (entry === undefined || entry.expiresAt <= server.now()) {
      return null;
    }
    return byId(entry.accountId) ?? null;
  }

  function keyHeader(request: SeenRequest, account: FakeAccount): Response | null {
    const header = request.headers['tabinet-key-id'];
    if (header === undefined || !KEY_ID.test(header)) {
      return error(400, 'bad_request');
    }
    if (account.key === null) {
      return error(409, 'key_missing');
    }
    return account.key.keyId === header ? null : error(409, 'key_mismatch');
  }

  async function route(request: SeenRequest): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }
    if (path === '/v1' || path.startsWith('/v1/')) {
      return error(410, 'upgrade_required');
    }
    const routes: Record<string, string> = {
      '/v2/auth/google': 'POST',
      '/v2/auth/logout': 'POST',
      '/v2/me': 'GET',
      '/v2/keys/open': 'POST',
      '/v2/keys': 'PUT',
      '/v2/records': 'GET,POST',
      '/v2/account': 'DELETE',
    };
    const allowed = routes[path];
    if (allowed === undefined) {
      return error(404, 'not_found');
    }
    if (!allowed.split(',').includes(request.method)) {
      return error(405, 'method_not_allowed', { Allow: allowed.replace(',', ', ') });
    }
    if (path === '/v2/auth/google') {
      const body = request.body;
      if (
        !isObject(body) ||
        !exactly(body, ['accessToken']) ||
        typeof body.accessToken !== 'string'
      ) {
        return error(400, 'bad_request');
      }
      const answer = server.google(body.accessToken);
      if (answer === 'refused') {
        return error(403, 'google_refused');
      }
      if (answer === 'unavailable') {
        return error(503, 'google_unavailable');
      }
      const account = upsert(answer.sub, answer.email);
      const { token, expiresAt } = issueToken(account);
      return jsonOk(200, {
        token,
        expiresAt,
        accountId: account.accountId,
        email: account.email,
        key: wireKey(account),
      });
    }
    const account = bearer(request);
    if (account === null) {
      return error(401, 'unauthorized');
    }
    if (path === '/v2/auth/logout') {
      const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
      tokens.delete(match?.[1] ?? '');
      return new Response(null, { status: 204 });
    }
    if (path === '/v2/me') {
      return jsonOk(200, {
        accountId: account.accountId,
        email: account.email,
        key: wireKey(account),
        usage: usageOf(account),
      });
    }
    if (path === '/v2/keys/open') {
      const refused = await identity(request, account);
      if (refused !== null) {
        return refused;
      }
      if (account.key === null) {
        return error(409, 'key_missing');
      }
      return jsonOk(200, { envelope: account.key.envelope });
    }
    if (path === '/v2/keys') {
      const refused = await identity(request, account);
      if (refused !== null) {
        return refused;
      }
      const body = request.body as Record<string, unknown>;
      if (
        !exactly(body, ['accessToken', 'envelope', 'proof']) ||
        !isEnvelope(body.envelope) ||
        typeof body.proof !== 'string' ||
        body.proof.length !== 44 ||
        b64Bytes(body.proof) !== 32
      ) {
        return error(400, 'bad_request');
      }
      const envelope = body.envelope;
      const verifier = await sha256Hex(body.proof);
      const current = account.key;
      if (current === null) {
        if (envelope.generation !== 1) {
          return error(409, 'key_missing');
        }
        if (account.records.size > 0) {
          return error(500, 'internal');
        }
        account.key = { keyId: envelope.keyId, generation: 1, verifier, envelope };
        return jsonOk(201, { key: { keyId: envelope.keyId, generation: 1 } });
      }
      if (envelope.generation === 1) {
        return error(409, 'key_exists');
      }
      if (current.keyId !== envelope.keyId) {
        return error(409, 'key_mismatch');
      }
      if (current.verifier !== verifier) {
        return error(403, 'proof_invalid');
      }
      if (envelope.generation !== current.generation + 1) {
        return error(409, 'generation_conflict');
      }
      account.key = { keyId: envelope.keyId, generation: envelope.generation, verifier, envelope };
      return jsonOk(200, { key: { keyId: envelope.keyId, generation: envelope.generation } });
    }
    if (path === '/v2/account') {
      const refused = await identity(request, account);
      if (refused !== null) {
        return refused;
      }
      accounts.delete(account.sub);
      for (const [token, entry] of tokens) {
        if (entry.accountId === account.accountId) {
          tokens.delete(token);
        }
      }
      return new Response(null, { status: 204 });
    }
    // /v2/records
    const keyRefused = keyHeader(request, account);
    if (keyRefused !== null) {
      return keyRefused;
    }
    if (request.method === 'GET') {
      return stream(url, account);
    }
    return push(request, account);
  }

  function stream(url: URL, account: FakeAccount): Response {
    const raw = url.searchParams.get('since') ?? '0';
    if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return error(400, 'bad_request');
    }
    const since = Number(raw);
    const through = account.lastSeq;
    const rows = [...account.records.values()]
      .filter((record) => record.seq > since && record.seq <= through)
      .sort((a, b) => a.seq - b.seq);
    let lines = [
      JSON.stringify({
        type: 'start',
        keyId: account.key!.keyId,
        since,
        through,
        usage: usageOf(account),
      }),
    ];
    let index = 0;
    let cursor = since;
    while (index < rows.length) {
      let bytes = 0;
      const batch: FakeServerRecord[] = [];
      while (
        index < rows.length &&
        batch.length < POLICY.pull.batchRecords &&
        (batch.length === 0 || bytes + rows[index]!.storedBytes <= POLICY.pull.batchBytes)
      ) {
        bytes += rows[index]!.storedBytes;
        batch.push(rows[index]!);
        index += 1;
      }
      for (const record of batch) {
        lines.push(JSON.stringify({ type: 'record', record: plainRecord(record) }));
      }
      cursor = batch[batch.length - 1]!.seq;
      lines.push(JSON.stringify({ type: 'checkpoint', cursor, count: batch.length }));
    }
    lines.push(JSON.stringify({ type: 'end', cursor: Math.max(since, through), complete: true }));
    if (server.streamLines !== undefined) {
      lines = server.streamLines(lines);
    }
    const body = new TextEncoder().encode(lines.map((line) => `${line}\n`).join(''));
    const chunks: Uint8Array[] = [];
    if (server.chunkBytes === Infinity) {
      chunks.push(body);
    } else {
      for (let start = 0; start < body.length; start += server.chunkBytes) {
        chunks.push(body.slice(start, start + server.chunkBytes));
      }
    }
    return ndjsonResponse(chunks);
  }

  function validPosted(
    value: unknown,
  ): value is Omit<RecordOut, 'seq'> & { baseSeq?: number | null } {
    if (!isObject(value)) {
      return false;
    }
    const isDoc = value.kind === 'doc';
    const keys = [
      'kind',
      'id',
      'updatedAt',
      'deleted',
      'iv',
      'ciphertext',
      ...(isDoc ? ['baseSeq'] : []),
    ];
    if (!exactly(value, keys)) {
      return false;
    }
    const { kind, id, updatedAt, deleted, iv, ciphertext, baseSeq } = value;
    const cipherBytes = b64Bytes(ciphertext);
    return (
      KINDS.some((known) => known === kind) &&
      typeof id === 'string' &&
      ID.test(id) &&
      (kind !== 'doc' || DOC_ID.test(id)) &&
      (kind !== 'settings' || (id === 'settings' && deleted === false)) &&
      typeof updatedAt === 'number' &&
      Number.isSafeInteger(updatedAt) &&
      updatedAt >= 0 &&
      typeof deleted === 'boolean' &&
      b64Bytes(iv) === 12 &&
      cipherBytes !== undefined &&
      cipherBytes >= 17 &&
      typeof ciphertext === 'string' &&
      ciphertext.length <=
        (deleted ? POLICY.record.maxTombstoneChars : POLICY.record.maxCiphertextBytes) &&
      (!isDoc || baseSeq === null || (typeof baseSeq === 'number' && Number.isSafeInteger(baseSeq)))
    );
  }

  function push(request: SeenRequest, account: FakeAccount): Response {
    const body = request.body;
    const raw = JSON.stringify(body);
    if (raw.length > POLICY.request.maxBodyBytes) {
      return error(413, 'payload_too_large');
    }
    const posted = isObject(body) && exactly(body, ['records']) ? body.records : undefined;
    if (
      !Array.isArray(posted) ||
      posted.length > POLICY.request.maxRecordsPerPush ||
      !posted.every(validPosted) ||
      new Set(posted.map((record) => `${record.kind}:${record.id}`)).size !== posted.length
    ) {
      return error(400, 'bad_request');
    }
    server.posts.push({ count: posted.length, bytes: raw.length });
    let staleBytes = 0;
    let results: WriteResult[] = posted.map((posted): WriteResult => {
      const { kind, id } = posted;
      if (posted.updatedAt > server.now() + POLICY.record.maxClockAheadMs) {
        return { kind, id, status: 'rejected', reason: 'clock_ahead' };
      }
      const { baseSeq, ...record } = posted;
      const outcome = write(account, record, baseSeq);
      if (typeof outcome === 'number') {
        return { kind, id, status: 'applied', seq: outcome };
      }
      if (outcome === 'absent') {
        return { kind, id, status: 'absent' };
      }
      if (outcome === 'image_limit' || outcome === 'storage_limit') {
        return { kind, id, status: 'rejected', reason: outcome };
      }
      const current = account.records.get(`${kind}:${id}`);
      if (current === undefined) {
        return { kind, id, status: 'stale', current: null };
      }
      const size = JSON.stringify(current).length;
      if (staleBytes > 0 && staleBytes + size > POLICY.request.maxStaleBytes) {
        return { kind, id, status: 'stale', withheld: true };
      }
      staleBytes += size;
      return { kind, id, status: 'stale', current: plainRecord(current) };
    });
    if (server.pushResults !== undefined) {
      results = server.pushResults(results);
    }
    return jsonOk(200, { results, usage: usageOf(account) });
  }

  return server;
}
