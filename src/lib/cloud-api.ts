/**
 * The sync server's API, protocol v2 (spec section 4): one typed function per route under `/v2`.
 * Every answer is checked by hand before it is trusted, and the record feed is read as a stream of
 * NDJSON lines whose grammar is checked line by line (`streamRecords()`). A failed request is a
 * `CloudHttpError` carrying the status and the server's error code (a 401 is
 * `CloudUnauthorizedError`), a request that took too long `CloudTimeoutError`, a network failure
 * or a cut stream an `ExplainedError`. Nothing here logs a token, a key or a ciphertext.
 */
import { POLICY } from '@/constants';
import { cloudSyncConfig } from '@/lib/cloud-config';
import { base64ByteLength, IV_BYTES, parseEnvelope } from '@/lib/cloud-crypto';
import { ExplainedError } from '@/lib/error-message';
import type { MessageKey } from '@/lib/i18n';
import type {
  ErrorCode,
  KeyEnvelope,
  RecordIn,
  RecordKind,
  RecordOut,
  Usage,
  WireKey,
  WriteResult,
} from '@/types';

export interface CloudApiOptions {
  /** Injectable for tests; defaults to the global `fetch`, looked up at call time. */
  fetch?: typeof fetch;
  /** The server origin; defaults to the configured `apiBase`. */
  apiBase?: string;
  /** Gives the request up (the sync run it belongs to was stopped). */
  signal?: AbortSignal;
  /** Whether this runs in the service worker; read from the global scope when omitted. */
  inWorker?: boolean;
}

const ERROR_CODES: readonly ErrorCode[] = [
  'bad_request',
  'unauthorized',
  'google_refused',
  'google_account_mismatch',
  'proof_invalid',
  'not_found',
  'method_not_allowed',
  'key_exists',
  'key_missing',
  'key_mismatch',
  'generation_conflict',
  'upgrade_required',
  'payload_too_large',
  'key_unavailable',
  'internal',
  'google_unavailable',
];

/** What the person reads for a failed request (the client column of spec 4.3). Pure. */
export function userKeyForHttp(status: number, code: ErrorCode | 'none'): MessageKey {
  switch (code) {
    case 'unauthorized':
      return 'errorCloudSignedOut';
    case 'google_refused':
      return 'errorCloudGoogleRefused';
    case 'google_account_mismatch':
      return 'errorCloudGoogleAccount';
    case 'proof_invalid':
    case 'key_missing':
    case 'key_mismatch':
      return 'errorCloudKeyChanged';
    case 'key_exists':
      return 'settingsAccountPassphraseExists';
    case 'generation_conflict':
      return 'errorCloudKeyConflict';
    case 'upgrade_required':
      return 'errorCloudUpgrade';
    case 'key_unavailable':
      return 'errorCloudKeyUnavailable';
    case 'internal':
      return 'errorCloudServer';
    case 'google_unavailable':
      return 'errorCloudGoogleUnavailable';
    case 'bad_request':
    case 'not_found':
    case 'method_not_allowed':
    case 'payload_too_large':
      return 'errorCloudRejected';
    case 'none':
      if (status === 401) {
        return 'errorCloudSignedOut';
      }
      if (status === 410) {
        return 'errorCloudUpgrade';
      }
      return status >= 500 ? 'errorCloudServer' : 'errorCloudRejected';
  }
}

/** A request the server answered with an error status. */
export class CloudHttpError extends ExplainedError {
  constructor(
    route: string,
    readonly status: number,
    readonly code: ErrorCode | 'none',
  ) {
    super(`${route}: HTTP ${status} (error ${code})`, userKeyForHttp(status, code));
    this.name = 'CloudHttpError';
  }
}

/** The bearer is missing, unknown or expired. */
export class CloudUnauthorizedError extends CloudHttpError {
  constructor(route: string) {
    super(route, 401, 'unauthorized');
    this.name = 'CloudUnauthorizedError';
  }
}

/** No answer in time. The worker halves its push batch on it. */
export class CloudTimeoutError extends ExplainedError {
  constructor(route: string) {
    super(`${route}: no answer in time`, 'errorCloudUnreachable');
    this.name = 'CloudTimeoutError';
  }
}

function badResponse(route: string, why: string): ExplainedError {
  return new ExplainedError(`${route}: unexpected answer (${why})`, 'errorCloudBadResponse');
}

function unreachable(route: string, err: unknown): ExplainedError {
  const reason = err instanceof Error ? err.name : 'unknown';
  return new ExplainedError(`${route}: network failure (${reason})`, 'errorCloudUnreachable');
}

function interrupted(route: string, why: string): ExplainedError {
  return new ExplainedError(`${route}: the stream ended early (${why})`, 'errorCloudInterrupted');
}

/** Whether this code runs in a service worker (Chrome stops its fetch at 30 s). */
export function inWorker(): boolean {
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
}

/**
 * How long a request may wait for its answer: in the worker the fixed `answerTimeoutMs` bounds
 * the whole request; in a page the body's length adds to it at `pageUploadBytesPerMs`, within
 * `pageTotalTimeoutMs`. Pure.
 */
export function answerTimeoutMs(bodyLength: number, worker: boolean): number {
  if (worker) {
    return POLICY.request.answerTimeoutMs;
  }
  return Math.min(
    POLICY.request.answerTimeoutMs + Math.round(bodyLength / POLICY.request.pageUploadBytesPerMs),
    POLICY.request.pageTotalTimeoutMs,
  );
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const KINDS: readonly RecordKind[] = ['session', 'settings', 'image', 'doc'];

export function isRecordKind(value: unknown): value is RecordKind {
  return KINDS.some((kind) => kind === value);
}

/** The id rules of spec 4.5 for `kind`. Pure. */
export function isValidRecordId(kind: RecordKind, id: string, deleted: boolean): boolean {
  if (kind === 'doc') {
    return DOC_ID.test(id);
  }
  if (kind === 'settings') {
    return id === 'settings' && !deleted;
  }
  return RECORD_ID.test(id);
}

export function isWireKey(value: unknown): value is WireKey {
  return (
    value === null ||
    (isObject(value) &&
      hasExactly(value, ['keyId', 'generation']) &&
      isString(value.keyId) &&
      KEY_ID.test(value.keyId) &&
      typeof value.generation === 'number' &&
      Number.isInteger(value.generation) &&
      value.generation >= 1 &&
      value.generation <= 2_147_483_647)
  );
}

export function isUsage(value: unknown): value is Usage {
  return (
    isObject(value) &&
    hasExactly(value, ['bytes', 'screenshots']) &&
    isCount(value.bytes) &&
    isCount(value.screenshots)
  );
}

/** A record exactly as the server sends it, with the id rules of its kind. */
export function isRecordOut(value: unknown): value is RecordOut {
  return (
    isObject(value) &&
    hasExactly(value, ['kind', 'id', 'updatedAt', 'deleted', 'iv', 'ciphertext', 'seq']) &&
    isRecordKind(value.kind) &&
    isString(value.id) &&
    typeof value.deleted === 'boolean' &&
    isValidRecordId(value.kind, value.id, value.deleted) &&
    isCount(value.updatedAt) &&
    isString(value.iv) &&
    base64ByteLength(value.iv) === IV_BYTES &&
    isString(value.ciphertext) &&
    value.ciphertext !== '' &&
    isCount(value.seq)
  );
}

function isWriteResult(value: unknown): value is WriteResult {
  if (!isObject(value) || !isRecordKind(value.kind) || !isString(value.id)) {
    return false;
  }
  switch (value.status) {
    case 'applied':
      return hasExactly(value, ['kind', 'id', 'status', 'seq']) && isCount(value.seq);
    case 'absent':
      return hasExactly(value, ['kind', 'id', 'status']);
    case 'stale':
      if (Object.hasOwn(value, 'withheld')) {
        return hasExactly(value, ['kind', 'id', 'status', 'withheld']) && value.withheld === true;
      }
      return (
        hasExactly(value, ['kind', 'id', 'status', 'current']) &&
        (value.current === null ? value.kind === 'doc' : isRecordOut(value.current))
      );
    case 'rejected':
      return (
        hasExactly(value, ['kind', 'id', 'status', 'reason']) &&
        (value.reason === 'image_limit' ||
          value.reason === 'storage_limit' ||
          value.reason === 'clock_ahead')
      );
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface Request {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  token?: string;
  keyId?: string;
  body?: unknown;
}

/** The full URL of `path` (which starts with `/v2/`) on the server. */
export function apiUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/+$/, '')}${path}`;
}

function routeOf(request: Request): string {
  return `${request.method} ${request.path.split('?')[0]}`;
}

async function errorCodeOf(response: Response): Promise<ErrorCode | 'none'> {
  try {
    const body: unknown = await response.json();
    if (isObject(body) && hasExactly(body, ['error'])) {
      const code = ERROR_CODES.find((known) => known === body.error);
      if (code !== undefined) {
        return code;
      }
    }
  } catch {
    // Not JSON: the status alone says what happened.
  }
  return 'none';
}

/** A response, and the abort that ends it (cleared by the caller once the body is read). */
interface Sent {
  response: Response;
  /** Stops the answer timer: the answer is all in (JSON) or a stream reads on its own bounds. */
  done(): void;
  timedOut(): boolean;
}

async function send(request: Request, options: CloudApiOptions): Promise<Sent> {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = {};
  if (request.token !== undefined) {
    headers.Authorization = `Bearer ${request.token}`;
  }
  if (request.keyId !== undefined) {
    headers['Tabinet-Key-Id'] = request.keyId;
  }
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const route = routeOf(request);
  const timer = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      timer.abort();
    },
    answerTimeoutMs(body?.length ?? 0, options.inWorker ?? inWorker()),
  );
  const signals = [timer.signal];
  if (options.signal !== undefined) {
    signals.push(options.signal);
  }
  let response: Response;
  try {
    response = await doFetch(apiUrl(options.apiBase ?? cloudSyncConfig().apiBase, request.path), {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.any(signals),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    throw timedOut ? new CloudTimeoutError(route) : unreachable(route, err);
  }
  if (!response.ok) {
    try {
      const code = await errorCodeOf(response);
      throw response.status === 401
        ? new CloudUnauthorizedError(route)
        : new CloudHttpError(route, response.status, code);
    } finally {
      clearTimeout(timeout);
    }
  }
  return { response, done: () => clearTimeout(timeout), timedOut: () => timedOut };
}

async function sendJson(
  request: Request,
  options: CloudApiOptions,
  statuses: readonly number[],
): Promise<{ status: number; body: unknown }> {
  const route = routeOf(request);
  const sent = await send(request, options);
  try {
    if (!statuses.includes(sent.response.status)) {
      throw badResponse(route, `status ${sent.response.status}`);
    }
    if (sent.response.status === 204) {
      return { status: 204, body: undefined };
    }
    let text: string;
    try {
      text = await sent.response.text();
    } catch (err: unknown) {
      throw sent.timedOut() ? new CloudTimeoutError(route) : unreachable(route, err);
    }
    try {
      const body: unknown = JSON.parse(text);
      return { status: sent.response.status, body };
    } catch {
      throw badResponse(route, 'not JSON');
    }
  } finally {
    sent.done();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface SignInAnswer {
  token: string;
  expiresAt: number;
  accountId: string;
  email: string;
  key: WireKey;
}

/** `POST /v2/auth/google`: trades a Google access token for the server's bearer. */
export async function authGoogle(
  accessToken: string,
  options: CloudApiOptions = {},
): Promise<SignInAnswer> {
  const request: Request = { method: 'POST', path: '/v2/auth/google', body: { accessToken } };
  const { body } = await sendJson(request, options, [200]);
  if (
    !isObject(body) ||
    !hasExactly(body, ['token', 'expiresAt', 'accountId', 'email', 'key']) ||
    !isString(body.token) ||
    body.token === '' ||
    !isCount(body.expiresAt) ||
    !isString(body.accountId) ||
    body.accountId === '' ||
    !isString(body.email) ||
    !isWireKey(body.key)
  ) {
    throw badResponse(routeOf(request), 'shape');
  }
  return {
    token: body.token,
    expiresAt: body.expiresAt,
    accountId: body.accountId,
    email: body.email,
    key: body.key,
  };
}

/** `POST /v2/auth/logout`: forgets `token` on the server. */
export async function logout(token: string, options: CloudApiOptions = {}): Promise<void> {
  await sendJson({ method: 'POST', path: '/v2/auth/logout', token }, options, [204]);
}

export interface MeAnswer {
  accountId: string;
  email: string;
  key: WireKey;
  usage: Usage;
}

/** `GET /v2/me`: the account, its key and its usage. */
export async function me(token: string, options: CloudApiOptions = {}): Promise<MeAnswer> {
  const request: Request = { method: 'GET', path: '/v2/me', token };
  const { body } = await sendJson(request, options, [200]);
  if (
    !isObject(body) ||
    !hasExactly(body, ['accountId', 'email', 'key', 'usage']) ||
    !isString(body.accountId) ||
    body.accountId === '' ||
    !isString(body.email) ||
    !isWireKey(body.key) ||
    !isUsage(body.usage)
  ) {
    throw badResponse(routeOf(request), 'shape');
  }
  return { accountId: body.accountId, email: body.email, key: body.key, usage: body.usage };
}

/** `POST /v2/keys/open`: the account's envelope, after a fresh Google check. */
export async function openKey(
  token: string,
  accessToken: string,
  options: CloudApiOptions = {},
): Promise<KeyEnvelope> {
  const request: Request = { method: 'POST', path: '/v2/keys/open', token, body: { accessToken } };
  const { body } = await sendJson(request, options, [200]);
  const envelope =
    isObject(body) && hasExactly(body, ['envelope']) ? parseEnvelope(body.envelope) : null;
  if (envelope === null) {
    throw badResponse(routeOf(request), 'envelope');
  }
  return envelope;
}

/** `PUT /v2/keys`: creates the envelope (201) or replaces it (200). */
export async function putKey(
  token: string,
  accessToken: string,
  envelope: KeyEnvelope,
  proof: string,
  options: CloudApiOptions = {},
): Promise<{ created: boolean; key: { keyId: string; generation: number } }> {
  const request: Request = {
    method: 'PUT',
    path: '/v2/keys',
    token,
    body: { accessToken, envelope, proof },
  };
  const { status, body } = await sendJson(request, options, [200, 201]);
  if (
    !isObject(body) ||
    !hasExactly(body, ['key']) ||
    !isWireKey(body.key) ||
    body.key === null ||
    body.key.keyId !== envelope.keyId ||
    body.key.generation !== envelope.generation
  ) {
    throw badResponse(routeOf(request), 'key');
  }
  return { created: status === 201, key: body.key };
}

/** `POST /v2/records`: writes up to `maxRecordsPerPush` records, results in the same order. */
export async function postRecords(
  token: string,
  keyId: string,
  records: readonly RecordIn[],
  options: CloudApiOptions = {},
): Promise<{ results: WriteResult[]; usage: Usage }> {
  const request: Request = { method: 'POST', path: '/v2/records', token, keyId, body: { records } };
  const { body } = await sendJson(request, options, [200]);
  if (
    !isObject(body) ||
    !hasExactly(body, ['results', 'usage']) ||
    !Array.isArray(body.results) ||
    !body.results.every(isWriteResult) ||
    !isUsage(body.usage)
  ) {
    throw badResponse(routeOf(request), 'shape');
  }
  return { results: body.results, usage: body.usage };
}

/** `DELETE /v2/account`: removes the account and everything stored for it, after a Google check. */
export async function deleteAccount(
  token: string,
  accessToken: string,
  options: CloudApiOptions = {},
): Promise<void> {
  await sendJson(
    { method: 'DELETE', path: '/v2/account', token, body: { accessToken } },
    options,
    [204],
  );
}

// ---------------------------------------------------------------------------
// GET /v2/records: the NDJSON stream (4.4, 10.3)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'start'; through: number; usage: Usage }
  | { type: 'batch'; records: RecordOut[]; cursor: number }
  | { type: 'end'; cursor: number; complete: boolean };

const NEWLINE = 0x0a;

/**
 * Lines of a byte stream, split on LF in the bytes themselves (no UTF-8 sequence holds an LF),
 * each decoded with a fatal decoder. A line longer than `maxBytes` throws. Every read waits at
 * most `idleMs`; the watchdog runs only while a read is awaited, never while the caller works.
 */
async function* readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  idleMs: number,
  route: string,
): AsyncGenerator<{ text: string; bytes: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [];
  let pending = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<'idle'>((resolve) => {
      timer = setTimeout(() => resolve('idle'), idleMs);
    });
    let result: ReadableStreamReadResult<Uint8Array> | 'idle';
    try {
      result = await Promise.race([reader.read(), idle]);
    } catch (err: unknown) {
      throw interrupted(route, err instanceof Error ? err.name : 'read failed');
    } finally {
      clearTimeout(timer);
    }
    if (result === 'idle') {
      throw interrupted(route, 'silent');
    }
    if (result.done) {
      if (pending > 0) {
        throw interrupted(route, 'a line without its end');
      }
      return;
    }
    const chunk = result.value;
    let start = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, index);
      const bytes = pending + piece.length;
      if (bytes > maxBytes) {
        throw badResponse(route, 'a line over the reader’s bound');
      }
      let line: Uint8Array;
      if (parts.length === 0) {
        line = piece;
      } else {
        line = new Uint8Array(bytes);
        let offset = 0;
        for (const part of [...parts, piece]) {
          line.set(part, offset);
          offset += part.length;
        }
      }
      parts = [];
      pending = 0;
      let text: string;
      try {
        text = decoder.decode(line);
      } catch {
        throw badResponse(route, 'not UTF-8');
      }
      yield { text, bytes };
      start = index + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.slice(start);
      pending += rest.length;
      if (pending > maxBytes) {
        throw badResponse(route, 'a line over the reader’s bound');
      }
      parts.push(rest);
    }
  }
}

function parseLine(text: string, route: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value)) {
      return value;
    }
  } catch {
    // Reported below.
  }
  throw badResponse(route, 'a line that is not a JSON object');
}

/**
 * `GET /v2/records?since=<since>` as a stream: `start`, then one `batch` per checkpoint (its
 * records and cursor), then `end`. The grammar `start (record+ checkpoint)* end` and every field
 * are checked as they arrive (10.3): our keyId and since, seq strictly rising above `since` and at
 * most `through`, the checkpoint's count and cursor, the end's cursor, nothing after the end. A
 * line or a batch over the reader's own bounds (`POLICY.pull`) is a bad answer. A stream that
 * stops without its end (EOF, an abort, the idle watchdog, a read error) throws
 * `errorCloudInterrupted`; the caller keeps only the batches it already committed.
 */
export async function* streamRecords(
  token: string,
  keyId: string,
  since: number,
  options: CloudApiOptions = {},
): AsyncGenerator<StreamEvent> {
  const request: Request = { method: 'GET', path: `/v2/records?since=${since}`, token, keyId };
  const route = routeOf(request);
  const sent = await send(request, options);
  // The answer has started: from here on the idle watchdog bounds the stream.
  sent.done();
  const { response } = sent;
  const type = response.headers.get('Content-Type') ?? '';
  if (response.status !== 200 || !/^application\/x-ndjson\b/.test(type) || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw badResponse(route, 'not an NDJSON stream');
  }
  const reader = response.body.getReader();
  let finished = false;
  try {
    let started = false;
    let through = 0;
    let lastSeq = since;
    let lastCheckpoint: number | undefined;
    let batch: RecordOut[] = [];
    let batchBytes = 0;
    let ended = false;
    const lines = readLines(reader, POLICY.pull.bufferBytes, POLICY.pull.readIdleMs, route);
    for (;;) {
      let next: IteratorResult<{ text: string; bytes: number }>;
      try {
        next = await lines.next();
      } catch (err: unknown) {
        // A connection left open and silent after a valid end line has said everything.
        if (ended && err instanceof ExplainedError && err.userKey === 'errorCloudInterrupted') {
          break;
        }
        throw err;
      }
      if (next.done === true) {
        break;
      }
      const { text, bytes } = next.value;
      if (ended) {
        throw badResponse(route, 'data after the end');
      }
      const line = parseLine(text, route);
      if (!started) {
        if (
          line.type !== 'start' ||
          !hasExactly(line, ['type', 'keyId', 'since', 'through', 'usage']) ||
          line.keyId !== keyId ||
          line.since !== since ||
          !isCount(line.through) ||
          !isUsage(line.usage)
        ) {
          throw badResponse(route, 'start');
        }
        started = true;
        through = line.through;
        yield { type: 'start', through, usage: line.usage };
        continue;
      }
      if (line.type === 'record') {
        const record = line.record;
        if (
          !hasExactly(line, ['type', 'record']) ||
          !isRecordOut(record) ||
          record.seq <= lastSeq ||
          record.seq > through
        ) {
          throw badResponse(route, 'record');
        }
        lastSeq = record.seq;
        batch.push(record);
        batchBytes += bytes;
        if (batch.length > POLICY.pull.bufferRecords || batchBytes > POLICY.pull.bufferBytes) {
          throw badResponse(route, 'a batch over the reader’s bound');
        }
        continue;
      }
      if (line.type === 'checkpoint') {
        if (
          !hasExactly(line, ['type', 'cursor', 'count']) ||
          batch.length === 0 ||
          line.count !== batch.length ||
          line.cursor !== lastSeq
        ) {
          throw badResponse(route, 'checkpoint');
        }
        lastCheckpoint = lastSeq;
        const records = batch;
        batch = [];
        batchBytes = 0;
        yield { type: 'batch', records, cursor: lastSeq };
        continue;
      }
      if (line.type === 'end') {
        if (
          !hasExactly(line, ['type', 'cursor', 'complete']) ||
          typeof line.complete !== 'boolean' ||
          batch.length > 0
        ) {
          throw badResponse(route, 'end');
        }
        const expected = line.complete ? Math.max(since, through) : lastCheckpoint;
        if (
          expected === undefined ||
          line.cursor !== expected ||
          (!line.complete && expected <= since)
        ) {
          throw badResponse(route, 'end cursor');
        }
        ended = true;
        yield { type: 'end', cursor: line.cursor, complete: line.complete };
        continue;
      }
      throw badResponse(route, 'an unknown line');
    }
    finished = true;
    if (!ended) {
      throw interrupted(route, started ? 'no end line' : 'no start line');
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
  }
}
