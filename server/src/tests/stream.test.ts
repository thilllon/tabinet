// GET /v2/records: the NDJSON stream of spec 4.4, against PGlite.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import type { Deps } from '../context.js';
import type { Query, Store } from '../db/store.js';
import type { PullLine } from '../types.js';
import {
  client,
  createTestDb,
  createTestDeps,
  newKey,
  rec,
  request,
  resetDb,
  signUp,
} from './helpers.js';

let db: PGlite;
let query: Query;
let store: Store;
let deps: Deps;
let clock: { now: number };
let account: Awaited<ReturnType<typeof signUp>>;
/** How many batches the app asked the database for. */
let batchQueries: number;

beforeAll(async () => {
  ({ db, query, store } = await createTestDb());
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDb(db);
  batchQueries = 0;
  const counted: Store = {
    ...store,
    streamBatch: async (...args) => {
      batchQueries += 1;
      return store.streamBatch(...args);
    },
  };
  ({ deps, clock } = createTestDeps(counted));
  account = await signUp(deps);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Rows straight into the database: `count` rows whose stored_bytes and ciphertext are `chars`. */
async function seed(count: number, chars: number, prefix = 'r') {
  await query(
    `INSERT INTO account_records (account_id, kind, id, updated_at, deleted, iv, ciphertext, stored_bytes, seq)
     SELECT $1, 'session', $3 || n, 1, false, 'AAAAAAAAAAAAAAAA', repeat('A', $2::int),
       greatest($2::int, 512) + 128, nextval('account_record_seq')
     FROM generate_series(1, $4::int) n`,
    [account.accountId, chars, prefix, count],
  );
  await query(
    'UPDATE accounts SET last_seq = (SELECT max(seq) FROM account_records WHERE account_id = $1) WHERE id = $1',
    [account.accountId],
  );
}

function pull(since?: number, keyId = account.keyId) {
  const path = since === undefined ? '/v2/records' : `/v2/records?since=${since}`;
  return client(deps).app.fetch(request('GET', path, { token: account.token, keyId }));
}

/** A reader of the stream, line by line, that reads only when asked. */
function lineReader(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunks = 0;
  let largestChunk = 0;
  return {
    reader,
    stats: () => ({ chunks, largestChunk }),
    /** The lines of the next chunk; null at the end of the stream. */
    async next(): Promise<PullLine[] | null> {
      const { done, value } = await reader.read();
      if (done) {
        return null;
      }
      chunks += 1;
      largestChunk = Math.max(largestChunk, value.byteLength);
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts.map((line) => JSON.parse(line) as PullLine);
    },
    async all(): Promise<PullLine[]> {
      const lines: PullLine[] = [];
      for (let part = await this.next(); part !== null; part = await this.next()) {
        lines.push(...part);
      }
      expect(buffer).toBe('');
      return lines;
    },
  };
}

/** The grammar `start (record+ checkpoint)* end?`; returns the batches. */
function batchesOf(lines: PullLine[]): { seqs: number[]; checkpoint: number }[] {
  expect(lines[0].type).toBe('start');
  const batches: { seqs: number[]; checkpoint: number }[] = [];
  let current: number[] = [];
  for (const line of lines.slice(1)) {
    if (line.type === 'record') {
      current.push(line.record.seq);
    } else if (line.type === 'checkpoint') {
      expect(current.length).toBeGreaterThan(0);
      expect(line.count).toBe(current.length);
      expect(line.cursor).toBe(current.at(-1));
      batches.push({ seqs: current, checkpoint: line.cursor });
      current = [];
    } else {
      expect(line.type).toBe('end');
      expect(line).toBe(lines.at(-1));
    }
  }
  expect(current).toEqual([]);
  return batches;
}

describe('the answer', () => {
  it('is start, the records, a checkpoint and end, with the exact fields', async () => {
    const push = await client(deps).call(
      request('POST', '/v2/records', {
        token: account.token,
        keyId: account.keyId,
        body: { records: [rec('session', 's1', 5), rec('image', 'i1', 6)] },
      }),
    );
    const [s1, i1] = push.body.results.map((r) => r.seq);
    const res = await pull();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store, no-transform');
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    expect(
      text
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        type: 'start',
        keyId: account.keyId,
        since: 0,
        through: i1,
        usage: { bytes: 2 * 640, screenshots: 1 },
      },
      { type: 'record', record: { ...rec('session', 's1', 5), seq: s1 } },
      { type: 'record', record: { ...rec('image', 'i1', 6), seq: i1 } },
      { type: 'checkpoint', cursor: i1, count: 2 },
      { type: 'end', cursor: i1, complete: true },
    ]);
    // Exact key order too: it is json() of each line.
    expect(text.split('\n')[0]).toBe(
      `{"type":"start","keyId":"${account.keyId}","since":0,"through":${i1},"usage":{"bytes":1280,"screenshots":1}}`,
    );
  });

  it('is start and end for an empty account, cursor max(since, through)', async () => {
    expect(await lineReader(await pull()).all()).toEqual([
      {
        type: 'start',
        keyId: account.keyId,
        since: 0,
        through: 0,
        usage: { bytes: 0, screenshots: 0 },
      },
      { type: 'end', cursor: 0, complete: true },
    ]);
    // since above through: answered normally, so a client notices a rewound database.
    const lines = await lineReader(await pull(50)).all();
    expect(lines).toEqual([
      {
        type: 'start',
        keyId: account.keyId,
        since: 50,
        through: 0,
        usage: { bytes: 0, screenshots: 0 },
      },
      { type: 'end', cursor: 50, complete: true },
    ]);
  });
});

describe('batches', () => {
  it('end at batchRecords rows, skipping and repeating nothing', async () => {
    await seed(450, 10);
    const lines = await lineReader(await pull()).all();
    const batches = batchesOf(lines);
    expect(batches.map((b) => b.seqs.length)).toEqual([200, 200, 50]);
    const seqs = batches.flatMap((b) => b.seqs);
    expect(new Set(seqs).size).toBe(450);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(lines.at(-1)).toEqual({ type: 'end', cursor: seqs.at(-1), complete: true });
  });

  it('end at batchBytes of stored bytes, a largest record going alone', async () => {
    const half = Math.floor(POLICY.pull.batchBytes / 2) - POLICY.record.overheadBytes;
    await seed(5, half, 'h');
    await seed(2, POLICY.record.maxCiphertextBytes, 'l');
    const batches = batchesOf(await lineReader(await pull()).all());
    expect(batches.map((b) => b.seqs.length)).toEqual([2, 2, 1, 1, 1]);
  });

  it('resume from any checkpoint with nothing skipped or repeated', async () => {
    await seed(450, 10);
    const all = batchesOf(await lineReader(await pull()).all());
    for (const { checkpoint } of all) {
      const rest = batchesOf(await lineReader(await pull(checkpoint)).all()).flatMap((b) => b.seqs);
      expect(rest).toEqual(all.flatMap((b) => b.seqs).filter((seq) => seq > checkpoint));
    }
  });

  it('stream 50 MiB one batch at a time, never holding more than a batch', async () => {
    await seed(50, POLICY.record.maxCiphertextBytes);
    const lines = lineReader(await pull());
    let records = 0;
    for (let part = await lines.next(); part !== null; part = await lines.next()) {
      records += part.filter((line) => line.type === 'record').length;
    }
    expect(records).toBe(50);
    expect(lines.stats().largestChunk).toBeLessThan(POLICY.pull.batchBytes + 4096);
    expect(batchQueries).toBe(51);
  });
});

describe('the reader sets the pace', () => {
  it('queries only when pulled: nothing queued ahead of a slow reader', async () => {
    await seed(450, 10);
    const res = await pull();
    const lines = lineReader(res);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batchQueries).toBe(0);
    expect((await lines.next())?.[0].type).toBe('start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batchQueries).toBe(0);
    await lines.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batchQueries).toBe(1);
    await lines.next();
    expect(batchQueries).toBe(2);
  });

  it('stops querying once cancelled', async () => {
    await seed(450, 10);
    const lines = lineReader(await pull());
    await lines.next();
    await lines.next();
    await lines.reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batchQueries).toBe(1);
  });

  it('ends incomplete after streamMs, at the last checkpoint', async () => {
    await seed(450, 10);
    const lines = lineReader(await pull());
    await lines.next();
    const first = (await lines.next()) ?? [];
    clock.now += POLICY.pull.streamMs;
    const rest = await lines.all();
    const checkpoint = first.at(-1);
    expect(checkpoint?.type).toBe('checkpoint');
    expect(rest).toEqual([
      {
        type: 'end',
        cursor: checkpoint?.type === 'checkpoint' ? checkpoint.cursor : -1,
        complete: false,
      },
    ]);
    expect(batchQueries).toBe(1);
  });

  it('never ends incomplete before the first batch went out', async () => {
    await seed(3, 10);
    const lines = lineReader(await pull());
    await lines.next();
    clock.now += POLICY.pull.streamMs * 2;
    const rest = await lines.all();
    expect(rest.at(-1)).toMatchObject({ type: 'end', complete: false });
    expect(rest.filter((line) => line.type === 'record')).toHaveLength(3);
  });

  it('a write during a stream arrives in the next pull', async () => {
    await seed(3, 10);
    const lines = lineReader(await pull());
    const start = (await lines.next())?.[0];
    await client(deps).call(
      request('POST', '/v2/records', {
        token: account.token,
        keyId: account.keyId,
        body: { records: [rec('session', 'late', 1)] },
      }),
    );
    const rest = await lines.all();
    const end = rest.at(-1);
    expect(end).toMatchObject({ type: 'end', complete: true });
    expect(rest.some((line) => line.type === 'record' && line.record.id === 'late')).toBe(false);
    expect(start?.type === 'start' && end?.type === 'end' && end.cursor === start.through).toBe(
      true,
    );
    const next = await lineReader(await pull(end?.type === 'end' ? end.cursor : 0)).all();
    expect(
      next
        .filter((line) => line.type === 'record')
        .map((line) => line.type === 'record' && line.record.id),
    ).toEqual(['late']);
  });
});

describe('a failure closes the stream without an end line, logging a name only', () => {
  async function failing(fail: () => Promise<never> | Promise<unknown>) {
    await seed(450, 10);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    deps.store = {
      ...store,
      streamBatch: async (...args) => {
        calls += 1;
        if (calls === 2) {
          await fail();
        }
        return store.streamBatch(...args);
      },
    };
    const lines = await lineReader(await pull()).all();
    expect(lines.at(-1)?.type).toBe('checkpoint');
    expect(lines.some((line) => line.type === 'end')).toBe(false);
    return log;
  }

  it('a throw', async () => {
    const log = await failing(async () => {
      throw new Error(`secret ${account.token}`);
    });
    expect(log.mock.calls).toEqual([['tabinet-server: pull stopped', 'Error']]);
  });

  it('a query timeout', async () => {
    const log = await failing(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    expect(log.mock.calls).toEqual([['tabinet-server: pull stopped', 'TimeoutError']]);
  });

  it('a deleted account', async () => {
    const log = await failing(() =>
      query('DELETE FROM accounts WHERE id = $1', [account.accountId]),
    );
    expect(log.mock.calls).toEqual([['tabinet-server: pull stopped', 'fenced']]);
  });

  it('a changed key', async () => {
    const log = await failing(() =>
      query('UPDATE accounts SET key_id = $2 WHERE id = $1', [
        account.accountId,
        newKey().envelope.keyId,
      ]),
    );
    expect(log.mock.calls).toEqual([['tabinet-server: pull stopped', 'fenced']]);
  });
});

describe('the start', () => {
  it('is a JSON 409 when the key changed after the bearer lookup', async () => {
    deps.store = {
      ...store,
      streamStart: async (id, keyId) => {
        await query('UPDATE accounts SET key_id = $2 WHERE id = $1', [id, newKey().envelope.keyId]);
        return store.streamStart(id, keyId);
      },
    };
    const res = await pull();
    expect([res.status, await res.text()]).toEqual([409, '{"error":"key_mismatch"}']);
  });

  it('fences every batch by account and key in SQL', async () => {
    await seed(5, 10);
    expect(
      await store.streamBatch(account.accountId, newKey().envelope.keyId, 0, 100, 10, 1000),
    ).toEqual({
      status: 'fenced',
    });
    const other = await signUp(deps, 'sub-2');
    const theirs = await store.streamBatch(
      other.accountId,
      other.keyId,
      0,
      1_000_000,
      10,
      1_000_000,
    );
    expect(theirs).toEqual({ status: 'rows', records: [] });
  });
});
