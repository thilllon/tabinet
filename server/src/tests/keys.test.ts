// The key routes (spec 4.3): create, open, replace, and how a hostile database or caller fails.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Deps } from '../context.js';
import type { Query, Store } from '../db/store.js';
import { importKeyEncryptionKey } from '../envelope.js';
import type { KeyEnvelope } from '../types.js';
import {
  client,
  createTestDb,
  createTestDeps,
  google,
  GOOGLE_DOWN,
  newKey,
  rec,
  request,
  resetDb,
  rewrapped,
  signUp,
} from './helpers.js';

let db: PGlite;
let query: Query;
let store: Store;
let deps: Deps;
/** Everything logged during the test, to check that nothing secret ever is. */
let logged: unknown[][];

beforeAll(async () => {
  ({ db, query, store } = await createTestDb());
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDb(db);
  ({ deps } = createTestDeps(store));
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const call = (req: Request) => client(deps).call(req);

async function signIn(sub = 'sub-1') {
  const res = await call(
    request('POST', '/v2/auth/google', { body: { accessToken: google(sub) } }),
  );
  return res.body as { token: string; accountId: string };
}

function put(token: string, envelope: KeyEnvelope, proof: string, accessToken = google()) {
  return call(request('PUT', '/v2/keys', { token, body: { accessToken, envelope, proof } }));
}

function openKey(token: string, accessToken = google()) {
  return call(request('POST', '/v2/keys/open', { token, body: { accessToken } }));
}

async function accountRow(accountId: string) {
  return (await query('SELECT * FROM accounts WHERE id = $1', [accountId]))[0];
}

describe('create', () => {
  it('creates once with 201 and opens it back', async () => {
    const { token } = await signIn();
    const key = newKey();
    const res = await put(token, key.envelope, key.proof);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ key: { keyId: key.envelope.keyId, generation: 1 } });
    const opened = await openKey(token);
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ envelope: key.envelope });
    expect((await call(request('GET', '/v2/me', { token }))).body.key).toEqual({
      keyId: key.envelope.keyId,
      generation: 1,
    });
  });

  it('refuses a second create with 409 key_exists, also with the same key', async () => {
    const { token } = await signIn();
    const key = newKey();
    await put(token, key.envelope, key.proof);
    const other = newKey();
    expect((await put(token, other.envelope, other.proof)).text).toBe('{"error":"key_exists"}');
    expect((await put(token, key.envelope, key.proof)).text).toBe('{"error":"key_exists"}');
    expect((await openKey(token)).body.envelope).toEqual(key.envelope);
  });

  it('lets exactly one of many concurrent creates win', async () => {
    const { token } = await signIn();
    const keys = Array.from({ length: 8 }, () => newKey());
    const answers = await Promise.all(keys.map((key) => put(token, key.envelope, key.proof)));
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const winner = keys[answers.findIndex((a) => a.status === 201)];
    expect((await openKey(token)).body.envelope).toEqual(winner.envelope);
  });

  it('is blocked by records stored without a key, as a damaged row: 500 internal', async () => {
    const { token, accountId } = await signIn();
    await query(
      `INSERT INTO account_records (account_id, kind, id, updated_at, deleted, iv, ciphertext, stored_bytes, seq)
       VALUES ($1, 'session', 's', 1, false, 'aXY=', 'Y3Q=', 640, 1)`,
      [accountId],
    );
    const key = newKey();
    const res = await put(token, key.envelope, key.proof);
    expect([res.status, res.text]).toEqual([500, '{"error":"internal"}']);
    expect((await accountRow(accountId)).key_id).toBeNull();
  });

  it('answers a replace before any key with 409 key_missing, and opening with 409 key_missing', async () => {
    const { token } = await signIn();
    const key = newKey(2);
    expect((await put(token, key.envelope, key.proof)).text).toBe('{"error":"key_missing"}');
    expect((await openKey(token)).text).toBe('{"error":"key_missing"}');
  });

  it.each([
    ['no envelope', (k: ReturnType<typeof newKey>) => ({ accessToken: google(), proof: k.proof })],
    [
      'a bad envelope',
      (k: ReturnType<typeof newKey>) => ({
        accessToken: google(),
        envelope: { ...k.envelope, v: 1 },
        proof: k.proof,
      }),
    ],
    [
      'a short proof',
      (k: ReturnType<typeof newKey>) => ({
        accessToken: google(),
        envelope: k.envelope,
        proof: Buffer.alloc(31).toString('base64'),
      }),
    ],
    [
      'an extra field',
      (k: ReturnType<typeof newKey>) => ({
        accessToken: google(),
        envelope: k.envelope,
        proof: k.proof,
        keyEncryptionKeyId: 'x',
      }),
    ],
  ])('refuses %s with 400 before asking Google', async (_name, body) => {
    const { token } = await signIn();
    const verify = vi.fn(deps.verifyGoogleToken);
    deps.verifyGoogleToken = verify;
    const res = await call(request('PUT', '/v2/keys', { token, body: body(newKey()) }));
    expect([res.status, res.text]).toEqual([400, '{"error":"bad_request"}']);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('replace', () => {
  it('needs the same key id, the proof and the generation one up: 200 with the new key', async () => {
    const a = await signUp(deps);
    const next = rewrapped(a.envelope);
    const res = await put(a.token, next, a.proof, a.accessToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: { keyId: a.keyId, generation: 2 } });
    expect((await openKey(a.token, a.accessToken)).body.envelope).toEqual(next);
  });

  it('refuses another key id (key_mismatch), another proof (proof_invalid), another generation', async () => {
    const a = await signUp(deps);
    const other = newKey(2);
    const cases: [KeyEnvelope, string, number, string][] = [
      [other.envelope, a.proof, 409, 'key_mismatch'],
      [rewrapped(a.envelope), other.proof, 403, 'proof_invalid'],
      [rewrapped(a.envelope, 3), a.proof, 409, 'generation_conflict'],
      [rewrapped(a.envelope, 1), a.proof, 409, 'key_exists'],
    ];
    for (const [envelope, proof, status, code] of cases) {
      const res = await put(a.token, envelope, proof, a.accessToken);
      expect([res.status, res.body.error]).toEqual([status, code]);
    }
    expect((await openKey(a.token, a.accessToken)).body.envelope).toEqual(a.envelope);
  });

  it('a stale replace, after another device changed it, is a generation_conflict', async () => {
    const a = await signUp(deps);
    expect((await put(a.token, rewrapped(a.envelope), a.proof)).status).toBe(200);
    const res = await put(a.token, rewrapped(a.envelope, 2), a.proof);
    expect([res.status, res.body.error]).toEqual([409, 'generation_conflict']);
  });

  it('lets exactly one of many concurrent changes win', async () => {
    const a = await signUp(deps);
    const changes = Array.from({ length: 6 }, () => rewrapped(a.envelope));
    const answers = await Promise.all(changes.map((e) => put(a.token, e, a.proof)));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    const winner = changes[answers.findIndex((r) => r.status === 200)];
    expect((await openKey(a.token)).body.envelope).toEqual(winner);
    expect((await accountRow(a.accountId)).key_generation).toBe(2);
  });

  it('makes the old envelope unobtainable: open answers only the new one', async () => {
    const a = await signUp(deps);
    const before = await accountRow(a.accountId);
    const next = rewrapped(a.envelope);
    await put(a.token, next, a.proof);
    const after = await accountRow(a.accountId);
    expect(after.sealed_envelope).not.toBe(before.sealed_envelope);
    const opened = (await openKey(a.token)).body.envelope;
    expect(opened).toEqual(next);
    expect(opened.salt).not.toBe(a.envelope.salt);
    expect(opened.wrapped).not.toBe(a.envelope.wrapped);
  });

  it('a Google token without the data key cannot replace it', async () => {
    const a = await signUp(deps);
    // Someone with the account's Google token, the key id and the generation, but no proof.
    const forged = rewrapped(a.envelope);
    const res = await put(a.token, forged, newKey().proof, a.accessToken);
    expect([res.status, res.body.error]).toEqual([403, 'proof_invalid']);
    expect((await openKey(a.token)).body.envelope).toEqual(a.envelope);
  });

  it('keeps the records: a replace touches no record', async () => {
    const a = await signUp(deps);
    await call(
      request('POST', '/v2/records', {
        token: a.token,
        keyId: a.keyId,
        body: { records: [rec('session', 's', 1)] },
      }),
    );
    expect((await put(a.token, rewrapped(a.envelope), a.proof)).status).toBe(200);
    expect(await query('SELECT count(*)::int AS n FROM account_records')).toEqual([{ n: 1 }]);
  });
});

describe('a key encryption key replaced (rotation or loss)', () => {
  it('gives key_unavailable until a change on a ready device reseals', async () => {
    const a = await signUp(deps);
    deps.keyEncryptionKey = await importKeyEncryptionKey(new Uint8Array(32).fill(42));
    const before = await accountRow(a.accountId);
    const res = await openKey(a.token);
    expect([res.status, res.text]).toEqual([500, '{"error":"key_unavailable"}']);
    expect(await accountRow(a.accountId)).toEqual(before);
    // A ready device changes the passphrase: the PUT needs no opening, and reseals.
    const next = rewrapped(a.envelope);
    expect((await put(a.token, next, a.proof)).status).toBe(200);
    expect((await accountRow(a.accountId)).key_encryption_key_id).toBe(deps.keyEncryptionKey.id);
    expect((await openKey(a.token)).body.envelope).toEqual(next);
  });
});

describe('a hostile database', () => {
  it('a sealed envelope moved to another row opens for neither', async () => {
    const a = await signUp(deps, 'sub-a');
    const b = await signUp(deps, 'sub-b');
    const rowA = await accountRow(a.accountId);
    const rowB = await accountRow(b.accountId);
    // A's blob onto B's row, and B's onto A's, key columns and all.
    for (const [from, to] of [
      [rowA, b.accountId],
      [rowB, a.accountId],
    ] as const) {
      await query(
        'UPDATE accounts SET key_id = $2, key_generation = $3, write_verifier = $4, key_encryption_key_id = $5, sealed_envelope = $6 WHERE id = $1',
        [
          to,
          from.key_id,
          from.key_generation,
          from.write_verifier,
          from.key_encryption_key_id,
          from.sealed_envelope,
        ],
      );
    }
    expect((await openKey(b.token, b.accessToken)).text).toBe('{"error":"key_unavailable"}');
    expect((await openKey(a.token, a.accessToken)).text).toBe('{"error":"key_unavailable"}');
  });

  it("a sub rewritten in the database opens nothing for the attacker's Google account", async () => {
    const victim = await signUp(deps, 'sub-victim');
    // The attacker rewrites the victim's row to their own sub, then signs in with their Google.
    await query("UPDATE accounts SET google_sub = 'sub-attacker' WHERE id = $1", [
      victim.accountId,
    ]);
    const attacker = await signIn('sub-attacker');
    expect(attacker.accountId).toBe(victim.accountId);
    const res = await openKey(attacker.token, google('sub-attacker'));
    expect([res.status, res.text]).toEqual([500, '{"error":"key_unavailable"}']);
  });

  it('a trigger rewriting the sub on insert gets nothing opened for the attacker', async () => {
    const victim = await signUp(deps, 'sub-victim');
    await db.exec(`
      CREATE FUNCTION hijack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.google_sub = 'sub-attacker' THEN
          NEW.google_sub := 'sub-victim';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER hijack BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION hijack();
    `);
    try {
      // The attacker's sign-in lands on the victim's row, so their bearer is the victim's account.
      const attacker = await signIn('sub-attacker');
      expect(attacker.accountId).toBe(victim.accountId);
      // Their own Google token is not the account's sub, and the sub is never read from SQL.
      for (const res of [
        await openKey(attacker.token, google('sub-attacker')),
        await call(
          request('DELETE', '/v2/account', {
            token: attacker.token,
            body: { accessToken: google('sub-attacker') },
          }),
        ),
      ]) {
        expect(res.text).toBe('{"error":"google_account_mismatch"}');
      }
    } finally {
      await db.exec('DROP TRIGGER hijack ON accounts; DROP FUNCTION hijack();');
    }
  });

  it.each([
    ['key_id', "'AAAAAAAAAAAAAAAAAAAAAA'"],
    ['key_generation', 'key_generation + 1'],
    ['key_encryption_key_id', "'0123456789abcdef'"],
    [
      'sealed_envelope',
      "overlay(sealed_envelope placing CASE WHEN substr(sealed_envelope, 30, 1) = 'A' THEN 'B' ELSE 'A' END from 30 for 1)",
    ],
  ])('an edited %s fails as key_unavailable and writes nothing', async (column, value) => {
    const a = await signUp(deps);
    await query(`UPDATE accounts SET ${column} = ${value} WHERE id = $1`, [a.accountId]);
    const before = await accountRow(a.accountId);
    const res = await openKey(a.token);
    expect([res.status, res.text]).toEqual([500, '{"error":"key_unavailable"}']);
    expect(await accountRow(a.accountId)).toEqual(before);
  });
});

describe('a hostile caller', () => {
  it('with a bearer alone gets no envelope and deletes nothing', async () => {
    const a = await signUp(deps);
    expect((await call(request('POST', '/v2/keys/open', { token: a.token }))).status).toBe(400);
    expect((await call(request('DELETE', '/v2/account', { token: a.token }))).status).toBe(400);
    expect((await call(request('GET', '/v2/me', { token: a.token }))).body.key).not.toBeNull();
    expect(
      JSON.stringify((await call(request('GET', '/v2/me', { token: a.token }))).body),
    ).not.toContain(a.envelope.wrapped);
  });

  it("gets 403 with another account's Google token on all three routes", async () => {
    const a = await signUp(deps, 'sub-a');
    await signUp(deps, 'sub-b');
    const theirs = google('sub-b');
    const answers = [
      await openKey(a.token, theirs),
      await put(a.token, rewrapped(a.envelope), a.proof, theirs),
      await call(
        request('DELETE', '/v2/account', { token: a.token, body: { accessToken: theirs } }),
      ),
    ];
    for (const res of answers) {
      expect([res.status, res.text]).toEqual([403, '{"error":"google_account_mismatch"}']);
    }
    expect((await openKey(a.token, a.accessToken)).body.envelope).toEqual(a.envelope);
  });

  it('gets 403 google_refused and 503 google_unavailable on the key routes', async () => {
    const a = await signUp(deps);
    expect((await openKey(a.token, 'refused')).text).toBe('{"error":"google_refused"}');
    expect((await openKey(a.token, GOOGLE_DOWN)).text).toBe('{"error":"google_unavailable"}');
    expect((await put(a.token, rewrapped(a.envelope), a.proof, GOOGLE_DOWN)).status).toBe(503);
  });

  it('gets 401 on open when the account was deleted after the bearer lookup', async () => {
    const a = await signUp(deps);
    const realRead = store.readSealed.bind(store);
    deps.store = {
      ...store,
      readSealed: async (id) => {
        await query('DELETE FROM accounts WHERE id = $1', [id]);
        return realRead(id);
      },
    };
    expect((await openKey(a.token)).status).toBe(401);
  });
});

describe('what the database and the logs hold', () => {
  it('holds no salt, wrapped key, proof, bearer or plain envelope anywhere', async () => {
    const a = await signUp(deps);
    await put(a.token, rewrapped(a.envelope), a.proof);
    await openKey(a.token);
    const dump = JSON.stringify([
      await query('SELECT row_to_json(a) AS r FROM accounts a'),
      await query('SELECT row_to_json(t) AS r FROM account_tokens t'),
      await query('SELECT row_to_json(r) AS r FROM account_records r'),
    ]);
    const secrets = [a.token, a.proof, a.envelope.salt, a.envelope.wrapped, a.envelope.iv];
    for (const secret of secrets) {
      const bytes = Buffer.from(secret, secret === a.token ? 'base64url' : 'base64');
      for (const form of [secret, bytes.toString('hex'), bytes.toString('base64url')]) {
        expect(dump).not.toContain(form);
      }
    }
    expect(dump).not.toContain('"v":2');
    expect(JSON.stringify(logged)).not.toMatch(
      new RegExp(secrets.map((s) => s.replace(/[+/=]/g, '\\$&')).join('|')),
    );
  });
});
