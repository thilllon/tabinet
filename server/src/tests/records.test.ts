// POST /v2/records (spec 4.5) and apply_account_record() (spec 5.1) on PGlite.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import type { Deps } from '../context.js';
import type { Query, Store } from '../db/store.js';
import type { RecordKind } from '../types.js';
import { storedBytesOf } from '../validation.js';
import {
  b64,
  ciphertextOfChars,
  client,
  createTestDb,
  createTestDeps,
  docId,
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

/** What a small row counts: a tombstone's minimum and the overhead. */
const MIN_ROW = POLICY.record.maxTombstoneChars + POLICY.record.overheadBytes;
const LIMIT = POLICY.account.storageBytes;

beforeAll(async () => {
  ({ db, query, store } = await createTestDb());
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDb(db);
  ({ deps, clock } = createTestDeps(store));
  account = await signUp(deps);
});

async function push(records: unknown[], who = account) {
  return client(deps).call(
    request('POST', '/v2/records', { token: who.token, keyId: who.keyId, body: { records } }),
  );
}

async function counters(accountId = account.accountId) {
  const [row] = await query(
    `SELECT a.storage_bytes::bigint AS bytes, a.screenshots,
       (SELECT coalesce(sum(stored_bytes), 0)::bigint FROM account_records r WHERE r.account_id = a.id) AS sum,
       (SELECT count(*)::int FROM account_records r
         WHERE r.account_id = a.id AND r.kind = 'image' AND NOT r.deleted) AS live
     FROM accounts a WHERE a.id = $1`,
    [accountId],
  );
  return {
    bytes: Number(row.bytes),
    screenshots: row.screenshots,
    sum: Number(row.sum),
    live: row.live,
  };
}

async function setUsed(bytes: number) {
  await query('UPDATE accounts SET storage_bytes = $2 WHERE id = $1', [account.accountId, bytes]);
}

describe('last writer wins for session, settings and image', () => {
  it.each<[RecordKind, string]>([
    ['session', 's1'],
    ['settings', 'settings'],
    ['image', 'i1'],
  ])(
    '%s: a newer write applies with a new seq, an older one or a tie is stale',
    async (kind, id) => {
      const first = await push([rec(kind, id, 10)]);
      expect(first.body.results).toEqual([
        { kind, id, status: 'applied', seq: expect.any(Number) },
      ]);
      const newer = await push([rec(kind, id, 20, { fill: 2 })]);
      expect(newer.body.results[0].seq).toBeGreaterThan(first.body.results[0].seq ?? 0);
      for (const updatedAt of [20, 5]) {
        const stale = await push([rec(kind, id, updatedAt, { fill: 3 })]);
        expect(stale.body.results).toEqual([
          {
            kind,
            id,
            status: 'stale',
            current: { ...rec(kind, id, 20, { fill: 2 }), seq: newer.body.results[0].seq },
          },
        ]);
      }
    },
  );

  it('keeps kinds apart: the same id as session and image is two rows', async () => {
    await push([rec('session', 'x', 1), rec('image', 'x', 1)]);
    expect(await query('SELECT kind FROM account_records ORDER BY kind')).toEqual([
      { kind: 'image' },
      { kind: 'session' },
    ]);
  });

  it('a tombstone beats an older live write, and a newer live write replaces it', async () => {
    await push([rec('session', 's', 5, { deleted: true })]);
    expect((await push([rec('session', 's', 4)])).body.results[0].status).toBe('stale');
    expect((await push([rec('session', 's', 6)])).body.results[0].status).toBe('applied');
  });
});

describe('docs: compare and swap', () => {
  const id = docId(1);

  it('applies a new doc only on baseSeq null, then only on the stored seq and a newer stamp', async () => {
    const created = await push([rec('doc', id, 10, { baseSeq: null })]);
    const seq = created.body.results[0].seq;
    expect(created.body.results[0].status).toBe('applied');
    // A second create, a wrong base, the right base with a stamp not newer: all stale.
    for (const [baseSeq, updatedAt] of [
      [null, 20],
      [(seq ?? 0) + 1, 20],
      [seq, 10],
      [seq, 9],
    ] as const) {
      const res = await push([rec('doc', id, updatedAt, { baseSeq })]);
      expect(res.body.results[0]).toMatchObject({
        status: 'stale',
        current: { seq, updatedAt: 10 },
      });
    }
    const edited = await push([rec('doc', id, 11, { baseSeq: seq, fill: 9 })]);
    expect(edited.body.results[0].status).toBe('applied');
  });

  it('answers current: null for a base on a doc the server does not have', async () => {
    const res = await push([rec('doc', id, 10, { baseSeq: 3 })]);
    expect(res.body.results).toEqual([{ kind: 'doc', id, status: 'stale', current: null }]);
  });

  it('a newer stamp alone does not win: two devices on one base, one wins', async () => {
    const seq = (await push([rec('doc', id, 10)])).body.results[0].seq;
    const a = await push([rec('doc', id, 20, { baseSeq: seq, fill: 2 })]);
    const b = await push([rec('doc', id, 30, { baseSeq: seq, fill: 3 })]);
    expect(a.body.results[0].status).toBe('applied');
    expect(b.body.results[0]).toMatchObject({ status: 'stale', current: { updatedAt: 20 } });
  });
});

describe('stale answers stay under the body limit', () => {
  it('withholds current past maxStaleBytes, always sending the first: 100 stale 1 MiB rows', async () => {
    // Written straight into the database: 100 MiB is more than any account may hold.
    await query(
      `INSERT INTO account_records (account_id, kind, id, updated_at, deleted, iv, ciphertext, stored_bytes, seq)
       SELECT $1, 'session', 's' || n, 100, false, 'AAAAAAAAAAAAAAAA', repeat('A', $2::int), $2::int, nextval('account_record_seq')
       FROM generate_series(1, 100) n`,
      [account.accountId, POLICY.record.maxCiphertextBytes],
    );
    const res = await push(Array.from({ length: 100 }, (_, n) => rec('session', `s${n + 1}`, 1)));
    expect(res.status).toBe(200);
    const results = res.body.results;
    const sent = results.filter((r) => 'current' in r);
    // Each current is a little over 1 MiB of JSON, so two fit in 3 MiB and a third does not.
    expect(sent).toHaveLength(2);
    expect(results.filter((r) => 'withheld' in r)).toHaveLength(100 - sent.length);
    expect(results[0]).toHaveProperty('current');
    expect(res.text.length).toBeLessThan(4_500_000);
  });
});

describe('the storage cap', () => {
  it('takes a write to exactly the limit and refuses one byte over', async () => {
    const { bytes } = await counters();
    await setUsed(LIMIT - MIN_ROW);
    expect((await push([rec('session', 'a', 1)])).body.results[0].status).toBe('applied');
    expect((await counters()).bytes).toBe(LIMIT);
    await setUsed(LIMIT - MIN_ROW + 1);
    expect((await push([rec('session', 'b', 1)])).body.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'storage_limit',
    });
    expect(await query("SELECT 1 FROM account_records WHERE id = 'b'")).toEqual([]);
    expect(bytes).toBe(0);
  });

  it('counts every row at least as a tombstone, plus the overhead', async () => {
    await push([rec('session', 'tiny', 1, { bytes: 18 })]);
    expect((await counters()).bytes).toBe(MIN_ROW);
    const big = ciphertextOfChars(4000);
    await push([{ ...rec('session', 'big', 1), ciphertext: big }]);
    expect((await counters()).bytes).toBe(MIN_ROW + 4000 + POLICY.record.overheadBytes);
    expect(storedBytesOf({ ciphertext: big })).toBe(4000 + POLICY.record.overheadBytes);
  });

  it('lets a shrinking write and a tombstone over an existing row through at a full account', async () => {
    await push([{ ...rec('session', 's', 1), ciphertext: ciphertextOfChars(4000) }]);
    await push([rec('session', 'gone', 1)]);
    await setUsed(LIMIT);
    expect((await push([rec('session', 'new', 1)])).body.results[0].reason).toBe('storage_limit');
    const shrink = await push([{ ...rec('session', 's', 2), ciphertext: ciphertextOfChars(1000) }]);
    expect(shrink.body.results[0].status).toBe('applied');
    expect((await counters()).bytes).toBe(LIMIT - 3000);
    await setUsed(LIMIT);
    const deleted = await push([rec('session', 'gone', 2, { deleted: true })]);
    expect(deleted.body.results[0].status).toBe('applied');
    expect((await counters()).bytes).toBe(LIMIT);
  });

  it('answers a tombstone for a row it lacks at a full account absent, storing nothing (5,000)', async () => {
    await setUsed(LIMIT);
    for (let batch = 0; batch < 50; batch++) {
      const records = Array.from({ length: 100 }, (_, n) =>
        rec('session', `ghost${batch * 100 + n}`, 1, { deleted: true }),
      );
      const res = await push(records);
      expect(res.body.results.every((r) => r.status === 'absent')).toBe(true);
    }
    expect(await query('SELECT count(*)::int AS n FROM account_records')).toEqual([{ n: 0 }]);
    expect((await counters()).bytes).toBe(LIMIT);
  });

  it('writes a tombstone for a row it lacks while it fits', async () => {
    const res = await push([rec('session', 'never', 1, { deleted: true })]);
    expect(res.body.results[0].status).toBe('applied');
    expect((await counters()).bytes).toBe(MIN_ROW);
  });

  it('counts mixed kinds together, with the usage in the answer', async () => {
    const res = await push([
      rec('session', 's', 1),
      rec('settings', 'settings', 1),
      rec('image', 'i', 1),
      rec('doc', docId(1), 1),
    ]);
    expect(res.body.usage).toEqual({ bytes: 4 * MIN_ROW, screenshots: 1 });
  });
});

describe('the screenshot cap', () => {
  it('keeps at most POLICY.account.screenshots live images; tombstones and rewrites always pass', async () => {
    const limit = POLICY.account.screenshots;
    for (let start = 0; start < limit; start += 100) {
      const count = Math.min(100, limit - start);
      await push(Array.from({ length: count }, (_, n) => rec('image', `i${start + n}`, 1)));
    }
    expect((await push([rec('image', 'one-more', 1)])).body.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'image_limit',
    });
    // A rewrite of a live image adds none.
    expect((await push([rec('image', 'i0', 2)])).body.results[0].status).toBe('applied');
    // A deletion makes room, and a deleted image comes back only while there is room.
    expect((await push([rec('image', 'i1', 2, { deleted: true })])).body.results[0].status).toBe(
      'applied',
    );
    expect((await push([rec('image', 'one-more', 1)])).body.results[0].status).toBe('applied');
    expect((await push([rec('image', 'i1', 3)])).body.results[0].reason).toBe('image_limit');
    expect(await counters()).toMatchObject({ screenshots: limit, live: limit });
    // Another account counts its own.
    const other = await signUp(deps, 'sub-2');
    expect((await push([rec('image', 'x', 1)], other)).body.results[0].status).toBe('applied');
  });
});

describe('clock_ahead', () => {
  it('refuses a stamp further ahead than maxClockAheadMs, record by record, before SQL', async () => {
    const edge = clock.now + POLICY.record.maxClockAheadMs;
    const res = await push([rec('session', 'a', edge + 1), rec('session', 'b', edge)]);
    expect(res.body.results).toEqual([
      { kind: 'session', id: 'a', status: 'rejected', reason: 'clock_ahead' },
      { kind: 'session', id: 'b', status: 'applied', seq: expect.any(Number) },
    ]);
    expect(await query("SELECT id FROM account_records WHERE id = 'a'")).toEqual([]);
  });
});

describe('a request cut short by an account or key change', () => {
  it('answers 409 and keeps what it wrote before', async () => {
    const realApply = store.applyRecord.bind(store);
    let applied = 0;
    deps.store = {
      ...store,
      applyRecord: async (...args) => {
        const result = await realApply(...args);
        applied += 1;
        if (applied === 1) {
          await query('UPDATE accounts SET key_id = $2 WHERE id = $1', [
            account.accountId,
            newKey().envelope.keyId,
          ]);
        }
        return result;
      },
    };
    const res = await push([rec('session', 'a', 1), rec('session', 'b', 1)]);
    expect([res.status, res.text]).toEqual([409, '{"error":"key_mismatch"}']);
    expect(await query('SELECT id FROM account_records')).toEqual([{ id: 'a' }]);
  });

  it('answers 401 when the account went', async () => {
    const realApply = store.applyRecord.bind(store);
    deps.store = {
      ...store,
      applyRecord: async (...args) => {
        await query('DELETE FROM accounts WHERE id = $1', [account.accountId]);
        return realApply(...args);
      },
    };
    expect((await push([rec('session', 'a', 1)])).status).toBe(401);
  });
});

describe('apply_account_record keeps its counters exact', () => {
  it('counters equal a SUM after 12,000 random writes and never pass the caps', async () => {
    // Small caps, passed straight to the function, so the random writes reach them often.
    const bytesLimit = 40_000;
    const shotsLimit = 5;
    let seed = 1234567;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const kinds: RecordKind[] = ['session', 'image', 'doc', 'settings'];
    const seqs = new Map<string, number>();
    let stamp = 1;
    for (let i = 0; i < 12_000; i++) {
      const kind = kinds[random(4)];
      const id =
        kind === 'settings' ? 'settings' : kind === 'doc' ? docId(random(20)) : `r${random(40)}`;
      const deleted = kind !== 'settings' && random(4) === 0;
      // As the server computes it: a tombstone (at most 512 characters) counts the minimum.
      const storedBytes = deleted ? MIN_ROW : MIN_ROW + random(4000);
      stamp += 1;
      const [row] = await query(
        'SELECT outcome, new_seq FROM apply_account_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          account.accountId,
          account.keyId,
          kind,
          id,
          random(10) === 0 ? 1 : stamp,
          deleted,
          'AAAAAAAAAAAAAAAA',
          b64(18),
          kind === 'doc' ? (seqs.get(id) ?? null) : null,
          storedBytes,
          bytesLimit,
          shotsLimit,
        ],
      );
      if (row.outcome === 'applied') {
        seqs.set(id, Number(row.new_seq));
      }
      if (i % 1000 === 999) {
        const c = await counters();
        expect(c.bytes).toBe(c.sum);
        expect(c.screenshots).toBe(c.live);
        expect(c.screenshots).toBeLessThanOrEqual(shotsLimit);
        expect(c.bytes).toBeLessThanOrEqual(bytesLimit);
      }
    }
    const c = await counters();
    expect(c.bytes).toBe(c.sum);
    expect(c.screenshots).toBe(c.live);
    expect(c.bytes).toBeLessThanOrEqual(bytesLimit);
  }, 120_000);
});

describe('the store', () => {
  it('passes a timeout signal with every statement', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { createSqlStore } = await import('../db/store.js');
    const spied = createSqlStore(async (text, params, options) => {
      signals.push(options?.signal);
      return query(text, params);
    });
    await spied.usage(account.accountId);
    await spied.findAccountByToken('x', clock.now);
    await spied.readRecord(account.accountId, 'session', 's');
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
