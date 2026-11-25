import { afterEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '@/constants';
import {
  answerTimeoutMs,
  authGoogle,
  CloudHttpError,
  CloudTimeoutError,
  CloudUnauthorizedError,
  me,
  openKey,
  postRecords,
  putKey,
  type StreamEvent,
  streamRecords,
  userKeyForHttp,
} from '@/lib/cloud-api';
import { ExplainedError } from '@/lib/error-message';
import type { KeyEnvelope, RecordOut } from '@/types';

import { fakeFetch, jsonResponse, ndjsonResponse } from './cloud-fetch';

const KEY_ID = 't5Je7_rzOWLofjmcQnKr6g';
const API = { apiBase: 'https://sync.test', inWorker: false };
const ENVELOPE: KeyEnvelope = {
  v: 2,
  generation: 1,
  keyId: KEY_ID,
  salt: 'QEFCQ0RFRkdISUpLTE1OTw==',
  iv: 'UFFSU1RVVldYWVpb',
  wrapped: 'kbL+5yJLYbNiEQsW0yD81CiZqMdC1uzUZ8faGsVufOZoHxSd0HFmCFvTJ8WC4rhU',
};
const USAGE = { bytes: 10, screenshots: 0 };

function record(seq: number, overrides: Partial<RecordOut> = {}): RecordOut {
  return {
    kind: 'session',
    id: `s${seq}`,
    updatedAt: seq,
    deleted: false,
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA',
    seq,
    ...overrides,
  };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const start = (since = 0, through = 2) =>
  line({ type: 'start', keyId: KEY_ID, since, through, usage: USAGE });
const rec = (r: RecordOut) => line({ type: 'record', record: r });
const checkpoint = (cursor: number, count: number) => line({ type: 'checkpoint', cursor, count });
const end = (cursor: number, complete = true) => line({ type: 'end', cursor, complete });
const GOOD = [start(0, 2), rec(record(1)), rec(record(2)), checkpoint(2, 2), end(2)].join('');

async function collect(chunks: (string | Uint8Array)[], since = 0): Promise<StreamEvent[]> {
  const { fetch } = fakeFetch(ndjsonResponse(chunks));
  const events: StreamEvent[] = [];
  for await (const event of streamRecords('tok', KEY_ID, since, { ...API, fetch })) {
    events.push(event);
  }
  return events;
}

async function failure(chunks: (string | Uint8Array)[], since = 0): Promise<string> {
  try {
    await collect(chunks, since);
  } catch (err: unknown) {
    if (err instanceof ExplainedError) {
      return err.userKey;
    }
    throw err;
  }
  return 'none';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('errors', () => {
  it('maps every code to what the person reads', () => {
    expect(userKeyForHttp(403, 'google_refused')).toBe('errorCloudGoogleRefused');
    expect(userKeyForHttp(403, 'google_account_mismatch')).toBe('errorCloudGoogleAccount');
    expect(userKeyForHttp(403, 'proof_invalid')).toBe('errorCloudKeyChanged');
    expect(userKeyForHttp(409, 'key_mismatch')).toBe('errorCloudKeyChanged');
    expect(userKeyForHttp(409, 'key_missing')).toBe('errorCloudKeyChanged');
    expect(userKeyForHttp(409, 'key_exists')).toBe('settingsAccountPassphraseExists');
    expect(userKeyForHttp(409, 'generation_conflict')).toBe('errorCloudKeyConflict');
    expect(userKeyForHttp(410, 'upgrade_required')).toBe('errorCloudUpgrade');
    expect(userKeyForHttp(500, 'key_unavailable')).toBe('errorCloudKeyUnavailable');
    expect(userKeyForHttp(500, 'internal')).toBe('errorCloudServer');
    expect(userKeyForHttp(503, 'google_unavailable')).toBe('errorCloudGoogleUnavailable');
    expect(userKeyForHttp(400, 'bad_request')).toBe('errorCloudRejected');
    expect(userKeyForHttp(502, 'none')).toBe('errorCloudServer');
    expect(userKeyForHttp(410, 'none')).toBe('errorCloudUpgrade');
  });

  it('reads a 401 as unauthorized and keeps status and code of the rest', async () => {
    const unauthorized = fakeFetch(jsonResponse(401, { error: 'unauthorized' }));
    await expect(me('tok', { ...API, fetch: unauthorized.fetch })).rejects.toBeInstanceOf(
      CloudUnauthorizedError,
    );
    const conflict = fakeFetch(jsonResponse(409, { error: 'key_mismatch' }));
    const err = await me('tok', { ...API, fetch: conflict.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudHttpError);
    expect(err).toMatchObject({
      status: 409,
      code: 'key_mismatch',
      userKey: 'errorCloudKeyChanged',
    });
    const unknown = fakeFetch(jsonResponse(418, { error: 'teapot' }));
    expect(
      await me('tok', { ...API, fetch: unknown.fetch }).catch((e: unknown) => e),
    ).toMatchObject({
      code: 'none',
    });
  });

  it('bounds the wait: the worker by the fixed answer time, a page by the body too', () => {
    expect(answerTimeoutMs(10 * 1024 * 1024, true)).toBe(POLICY.request.answerTimeoutMs);
    expect(answerTimeoutMs(64_000, false)).toBe(POLICY.request.answerTimeoutMs + 1000);
    expect(answerTimeoutMs(1e12, false)).toBe(POLICY.request.pageTotalTimeoutMs);
  });

  it('gives up a request that gets no answer as a timeout', async () => {
    vi.useFakeTimers();
    const fetch: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const pending = me('tok', { ...API, inWorker: true, fetch }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(POLICY.request.answerTimeoutMs);
    expect(await pending).toBeInstanceOf(CloudTimeoutError);
  });
});

describe('routes', () => {
  it('signs in and checks every field of the answer', async () => {
    const answer = { token: 't', expiresAt: 5, accountId: 'a', email: 'e@x', key: null };
    const ok = fakeFetch(jsonResponse(200, answer));
    expect(await authGoogle('g', { ...API, fetch: ok.fetch })).toEqual(answer);
    expect(ok.requests[0]).toMatchObject({ method: 'POST', body: { accessToken: 'g' } });
    expect(ok.requests[0]!.url).toBe('https://sync.test/v2/auth/google');
    for (const bad of [
      { ...answer, extra: 1 },
      { ...answer, key: { keyId: 'short', generation: 1 } },
      { ...answer, expiresAt: 'soon' },
      { ...answer, accountId: '' },
    ]) {
      const fetch = fakeFetch(jsonResponse(200, bad)).fetch;
      await expect(authGoogle('g', { ...API, fetch })).rejects.toMatchObject({
        userKey: 'errorCloudBadResponse',
      });
    }
  });

  it('reads me with its usage', async () => {
    const body = {
      accountId: 'a',
      email: 'e',
      key: { keyId: KEY_ID, generation: 3 },
      usage: USAGE,
    };
    expect(await me('tok', { ...API, fetch: fakeFetch(jsonResponse(200, body)).fetch })).toEqual(
      body,
    );
    const bad = { ...body, usage: { bytes: -1, screenshots: 0 } };
    await expect(
      me('tok', { ...API, fetch: fakeFetch(jsonResponse(200, bad)).fetch }),
    ).rejects.toMatchObject({
      userKey: 'errorCloudBadResponse',
    });
  });

  it('opens only an exact envelope', async () => {
    const ok = fakeFetch(jsonResponse(200, { envelope: ENVELOPE }));
    expect(await openKey('tok', 'g', { ...API, fetch: ok.fetch })).toEqual(ENVELOPE);
    for (const envelope of [
      { ...ENVELOPE, generation: 0 },
      { ...ENVELOPE, wrapped: 'AAAA' },
      { ...ENVELOPE, kdf: 1 },
    ]) {
      const fetch = fakeFetch(jsonResponse(200, { envelope })).fetch;
      await expect(openKey('tok', 'g', { ...API, fetch })).rejects.toMatchObject({
        userKey: 'errorCloudBadResponse',
      });
    }
  });

  it('puts a key and tells a create from a replace', async () => {
    const key = { keyId: KEY_ID, generation: 1 };
    const created = fakeFetch(jsonResponse(201, { key }));
    expect(await putKey('tok', 'g', ENVELOPE, 'p', { ...API, fetch: created.fetch })).toEqual({
      created: true,
      key,
    });
    expect(created.requests[0]!.body).toEqual({ accessToken: 'g', envelope: ENVELOPE, proof: 'p' });
    const other = fakeFetch(jsonResponse(200, { key: { keyId: KEY_ID, generation: 9 } }));
    await expect(
      putKey('tok', 'g', ENVELOPE, 'p', { ...API, fetch: other.fetch }),
    ).rejects.toMatchObject({
      userKey: 'errorCloudBadResponse',
    });
  });

  it('posts records with the key header and checks every result', async () => {
    const results = [
      { kind: 'session', id: 's1', status: 'applied', seq: 4 },
      { kind: 'doc', id: 'x'.repeat(43), status: 'stale', current: null },
      { kind: 'session', id: 's2', status: 'stale', withheld: true },
      { kind: 'image', id: 'i', status: 'rejected', reason: 'image_limit' },
      { kind: 'session', id: 's3', status: 'absent' },
    ];
    const ok = fakeFetch(jsonResponse(200, { results, usage: USAGE }));
    expect(await postRecords('tok', KEY_ID, [], { ...API, fetch: ok.fetch })).toEqual({
      results,
      usage: USAGE,
    });
    expect(ok.requests[0]!.headers['tabinet-key-id']).toBe(KEY_ID);
    for (const bad of [
      { kind: 'session', id: 's', status: 'stale', current: null },
      { kind: 'session', id: 's', status: 'rejected', reason: 'other' },
      { kind: 'session', id: 's', status: 'applied' },
    ]) {
      const fetch = fakeFetch(jsonResponse(200, { results: [bad], usage: USAGE })).fetch;
      await expect(postRecords('tok', KEY_ID, [], { ...API, fetch })).rejects.toMatchObject({
        userKey: 'errorCloudBadResponse',
      });
    }
  });
});

describe('the record stream', () => {
  it('reads start, batches and end', async () => {
    expect(await collect([GOOD])).toEqual([
      { type: 'start', through: 2, usage: USAGE },
      { type: 'batch', records: [record(1), record(2)], cursor: 2 },
      { type: 'end', cursor: 2, complete: true },
    ]);
  });

  it('reads the same whatever byte the chunks are split at', async () => {
    const bytes = new TextEncoder().encode(GOOD);
    const whole = await collect([GOOD]);
    for (let at = 1; at < bytes.length; at += 1) {
      expect(await collect([bytes.slice(0, at), bytes.slice(at)])).toEqual(whole);
    }
    expect(await collect([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(whole);
  });

  it('decodes a character split across chunks', async () => {
    const text = [start(0, 1), rec(record(1, { id: 'n1' })), checkpoint(1, 1), end(1)].join('');
    const withKorean = text.replace('"start"', '"start","x":"한"').replace(',"x":"한"', '');
    const bytes = new TextEncoder().encode(withKorean);
    expect((await collect([bytes.slice(0, 5), bytes.slice(5)])).length).toBe(3);
    const bad = new TextEncoder().encode(start(0, 0)).slice(0, -1);
    expect(await failure([bad, Uint8Array.of(0xff, 0x0a), end(0)])).toBe('errorCloudBadResponse');
  });

  it('is interrupted when it is cut after any line', async () => {
    const lines = GOOD.split('\n')
      .filter(Boolean)
      .map((text) => `${text}\n`);
    for (let count = 0; count < lines.length; count += 1) {
      expect(await failure(lines.slice(0, count))).toBe('errorCloudInterrupted');
    }
    expect(await failure([GOOD.slice(0, -5)])).toBe('errorCloudInterrupted');
  });

  it('refuses anything out of grammar', async () => {
    const cases: string[][] = [
      [rec(record(1)), checkpoint(1, 1), end(1)],
      [start(0, 2), checkpoint(0, 0), end(2)],
      [start(0, 2), rec(record(1)), end(2)],
      [GOOD, end(2)],
      [GOOD, rec(record(3))],
      [start(0, 2), rec(record(2)), rec(record(1)), checkpoint(1, 2), end(2)],
      [start(0, 2), rec(record(1)), rec(record(1)), checkpoint(1, 2), end(2)],
      [start(0, 2), rec(record(3)), checkpoint(3, 1), end(3)],
      [start(0, 2), rec(record(1)), checkpoint(1, 2), end(2)],
      [start(0, 2), rec(record(1)), checkpoint(2, 1), end(2)],
      [start(0, 2), rec(record(1)), checkpoint(1, 1), end(1)],
      [start(0, 2), rec(record(1)), checkpoint(1, 1), end(2, false)],
      [start(0, 2), end(0, false)],
      [line({ type: 'start', keyId: 'A'.repeat(22), since: 0, through: 0, usage: USAGE }), end(0)],
      [line({ type: 'start', keyId: KEY_ID, since: 5, through: 0, usage: USAGE }), end(0)],
      [line({ type: 'start', keyId: KEY_ID, since: 0, through: Number.NaN, usage: USAGE }), end(0)],
      [start(0, 2), rec(record(1, { kind: 'doc', id: 'short' })), checkpoint(1, 1), end(2)],
      [start(0, 2), rec(record(1, { kind: 'settings', id: 'other' })), checkpoint(1, 1), end(2)],
      [
        start(0, 2),
        rec(record(1, { kind: 'settings', id: 'settings', deleted: true })),
        checkpoint(1, 1),
        end(2),
      ],
      [start(0, 2), rec({ ...record(1), extra: 1 } as RecordOut), checkpoint(1, 1), end(2)],
      [start(0, 2), line({ type: 'other' }), end(2)],
      ['not json\n'],
    ];
    for (const chunks of cases) {
      expect(await failure(chunks)).toBe('errorCloudBadResponse');
    }
  });

  it('accepts an incomplete end at the last checkpoint, and a since past through', async () => {
    const partial = [start(0, 9), rec(record(1)), checkpoint(1, 1), end(1, false)];
    expect((await collect(partial)).at(-1)).toEqual({ type: 'end', cursor: 1, complete: false });
    const rewound = [
      line({ type: 'start', keyId: KEY_ID, since: 7, through: 3, usage: USAGE }),
      end(7),
    ];
    expect(await collect(rewound, 7)).toEqual([
      { type: 'start', through: 3, usage: USAGE },
      { type: 'end', cursor: 7, complete: true },
    ]);
  });

  it('refuses a line or a batch over the reader’s bounds', async () => {
    const huge = `"${'A'.repeat(POLICY.pull.bufferBytes)}"`;
    expect(await failure([start(0, 1), `${huge}\n`])).toBe('errorCloudBadResponse');
    expect(await failure([start(0, 1), huge])).toBe('errorCloudBadResponse');
    const many = Array.from({ length: POLICY.pull.bufferRecords + 1 }, (_, i) =>
      rec(record(i + 1)),
    );
    const through = POLICY.pull.bufferRecords + 1;
    expect(
      await failure([start(0, through), ...many, checkpoint(through, through), end(through)]),
    ).toBe('errorCloudBadResponse');
  });

  it('refuses another content type and a JSON error', async () => {
    const wrongType = new Response(GOOD, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetch = fakeFetch(wrongType).fetch;
    const iterate = async () => {
      for await (const _event of streamRecords('tok', KEY_ID, 0, { ...API, fetch })) {
        // Nothing arrives.
      }
    };
    await expect(iterate()).rejects.toMatchObject({ userKey: 'errorCloudBadResponse' });
    const conflict = fakeFetch(jsonResponse(409, { error: 'key_mismatch' })).fetch;
    const iterateConflict = async () => {
      for await (const _event of streamRecords('tok', KEY_ID, 0, { ...API, fetch: conflict })) {
        // Nothing arrives.
      }
    };
    await expect(iterateConflict()).rejects.toMatchObject({ status: 409, code: 'key_mismatch' });
  });

  it('cuts a stream that sends nothing while it is read', async () => {
    vi.useFakeTimers();
    const silent = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(start(0, 1)));
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
    );
    const events: StreamEvent[] = [];
    const run = (async () => {
      for await (const event of streamRecords('tok', KEY_ID, 0, {
        ...API,
        fetch: fakeFetch(silent).fetch,
      })) {
        events.push(event);
      }
    })().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(POLICY.pull.readIdleMs + 1);
    expect(await run).toMatchObject({ userKey: 'errorCloudInterrupted' });
    expect(events).toHaveLength(1);
  });

  it('does not count a slow consumer as silence', async () => {
    vi.useFakeTimers();
    const fetch = fakeFetch(ndjsonResponse([GOOD])).fetch;
    const events: StreamEvent[] = [];
    for await (const event of streamRecords('tok', KEY_ID, 0, { ...API, fetch })) {
      events.push(event);
      await vi.advanceTimersByTimeAsync(POLICY.pull.readIdleMs * 2);
    }
    expect(events).toHaveLength(3);
  });
});
