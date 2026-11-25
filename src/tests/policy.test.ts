import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import { getRecords, isCloudKeySetup } from '@/lib/cloud-api';
import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY, newPassphraseProblem } from '@/lib/cloud-auth';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { createKeySetup, encryptRecord, toBase64 } from '@/lib/cloud-crypto';
import { splitIntoBatches, syncNow } from '@/lib/cloud-sync';
import { sessionRepo } from '@/lib/session-repo';
import { type CloudRecord, SESSION_SCHEMA_VERSION, type Session } from '@/types';

import {
  parseAccessToken,
  parseKeySetup,
  parseRecordsBody,
  parseRecordsQuery,
} from '../../server/src/validation';
import { getChromeFake } from './chrome-fake';
import { fakeSyncServer } from './cloud-fetch';

// The numbers are written out here on purpose: changing a policy has to be a visible change, and
// the server's own validation has to agree with the client at each of them.

const MIB = 1_048_576;

it('POLICY holds these numbers', () => {
  expect(POLICY).toEqual({
    account: { storageBytes: 52_428_800, screenshots: 100 },
    record: { maxCiphertextBytes: 1_048_576 },
    request: {
      maxRecordsPerPush: 100,
      maxBodyBytes: 4_194_304,
      pushBatchBytes: 3_670_016,
      maxRecordsPerPull: 500,
      maxAccessTokenChars: 4096,
    },
    passphrase: { minLength: 8 },
    kdf: {
      iterations: 600_000,
      minIterations: 100_000,
      maxIterations: 10_000_000,
      saltBytes: 16,
      minSaltBytes: 16,
      maxSaltBytes: 64,
    },
    signIn: { tokenLifetimeMs: 7_776_000_000 },
    sync: { periodMinutes: 15, debounceMs: 2500, maxWaitMs: 10_000, fallbackMs: 30_000 },
    screenshot: { maxWidth: 1280, quality: 0.8 },
    snapshots: {
      intervalMinutes: { min: 1, default: 5, max: 1440, choices: [5, 10, 30] },
      keep: { min: 1, default: 20, max: 200 },
      keepRecovered: 2,
    },
    restore: { lazyAboveTabs: 10 },
    import: { maxFileBytes: 20_971_520 },
  });
});

describe('the client and the server draw the same lines', () => {
  beforeEach(() => {
    overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
  });
  afterEach(() => {
    overrideCloudSyncConfig();
  });

  const b64 = (bytes: number) => toBase64(new Uint8Array(bytes));
  const record = (id: string, ciphertext: string): CloudRecord => ({
    kind: 'session',
    id,
    updatedAt: 1,
    deleted: false,
    iv: b64(12),
    ciphertext,
  });

  it.each([
    [99_999, 16, false],
    [100_000, 16, true],
    [10_000_000, 16, true],
    [10_000_001, 16, false],
    [600_000, 15, false],
    [600_000, 64, true],
    [600_000, 65, false],
  ])('%i rounds with a %i byte salt: accepted %s', (iterations, saltBytes, accepted) => {
    const setup = {
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations },
      salt: b64(saltBytes),
      check: b64(36),
      checkIv: b64(12),
    };
    expect(isCloudKeySetup(setup)).toBe(accepted);
    expect(parseKeySetup(setup) !== null).toBe(accepted);
  });

  it('makes a new key the server accepts', async () => {
    const { setup } = await createKeySetup('long enough');
    expect(parseKeySetup(setup)).toEqual(setup);
  });

  it('puts as many records in a push as the server takes, and no more', () => {
    const records = Array.from({ length: 101 }, (_, i) => record(`r${i}`, 'AAAA'));
    const batches = splitIntoBatches(records);
    expect(batches.map((batch) => batch.length)).toEqual([100, 1]);
    expect(parseRecordsBody({ records: batches[0] })).not.toBeNull();
    expect(parseRecordsBody({ records })).toBeNull();
  });

  it('keeps a push of the largest records within 3.5 MiB', () => {
    const largest = 'A'.repeat(MIB);
    const batches = splitIntoBatches([1, 2, 3, 4].map((i) => record(`r${i}`, largest)));
    expect(batches.map((batch) => batch.length)).toEqual([3, 1]);
    for (const records of batches) {
      expect(JSON.stringify({ records }).length).toBeLessThanOrEqual(3.5 * MIB);
      expect(parseRecordsBody({ records })).not.toBeNull();
    }
  });

  it('sends no batch bigger than the body the server reads', () => {
    expect(POLICY.request.pushBatchBytes).toBeLessThan(POLICY.request.maxBodyBytes);
  });

  it.each([
    // AES-GCM adds 16 bytes and base64 turns 3 bytes into 4: the first is exactly 1 MiB, the
    // second the next size there is.
    [786_416, true],
    [786_417, false],
  ])('a session of %i bytes: sent by the client and accepted %s', async (bytes, accepted) => {
    const session: Session = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: 's',
      kind: 'saved',
      name: '',
      origin: 'manual',
      createdAt: 1,
      // put() stamps the time of saving, so the padding allows for its 13 digits.
      updatedAt: Date.now(),
      windows: [{ state: 'normal', focused: false, groups: [], tabs: [] }],
    };
    session.name = 'x'.repeat(bytes - JSON.stringify(session).length);
    const key = b64(32);
    const { local } = getChromeFake().state;
    local.set(CLOUD_ACCOUNT_KEY, { token: 'tok', expiresAt: 4_000_000_000_000, email: 'a@b.c' });
    local.set(CLOUD_SYNC_KEY, key);
    await sessionRepo.put(session);

    const server = fakeSyncServer();
    // What the client sends, not what the fake server keeps: that one has limits of its own.
    const sent: string[] = [];
    await syncNow({
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          sent.push(String(init.body));
        }
        return server.fetch(url, init);
      },
    });
    expect(sent.some((body) => body.includes('"kind":"session"'))).toBe(accepted);

    const meta = { kind: 'session', id: 's', updatedAt: 1, deleted: false } as const;
    const body = await sessionRepo.get('s');
    expect(JSON.stringify(body)).toHaveLength(bytes);
    const payload = await encryptRecord(key, meta, body);
    expect(parseRecordsBody({ records: [{ ...meta, ...payload }] }) !== null).toBe(accepted);
  });

  it('pulls pages of 500, the most the server gives', async () => {
    let asked = new URLSearchParams();
    await getRecords('tok', 0, undefined, {
      fetch: async (url) => {
        asked = new URL(String(url)).searchParams;
        return Response.json({ records: [], next: 0, hasMore: false });
      },
    });
    expect(parseRecordsQuery(asked)?.limit).toBe(500);
    expect(parseRecordsQuery(new URLSearchParams('limit=500'))?.limit).toBe(500);
    expect(parseRecordsQuery(new URLSearchParams('limit=501'))).toBeNull();
  });

  it('takes an access token of 4096 characters and a passphrase of 8', () => {
    expect(parseAccessToken({ accessToken: 'a'.repeat(4096) })).not.toBeNull();
    expect(parseAccessToken({ accessToken: 'a'.repeat(4097) })).toBeNull();
    expect(newPassphraseProblem('1234567', '1234567')).toBe('tooShort');
    expect(newPassphraseProblem('12345678', '12345678')).toBeNull();
  });
});
