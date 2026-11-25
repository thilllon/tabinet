import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import { answerTimeoutMs, isValidRecordId } from '@/lib/cloud-api';
import { encryptRecord, toBase64 } from '@/lib/cloud-crypto';
import { recordBytes, splitIntoBatches } from '@/lib/cloud-sync';
import type { RecordIn } from '@/types';

// The client's own lines, drawn at the POLICY values (the server's are checked in
// server/src/tests/policy-server.test.ts).

const DEK = toBase64(new Uint8Array(32).fill(3));
const record = (id: string, ciphertext: string): RecordIn => ({
  kind: 'session',
  id,
  updatedAt: 1,
  deleted: false,
  iv: toBase64(new Uint8Array(12)),
  ciphertext,
});

describe('push batches', () => {
  it('hold at most maxRecordsPerPush records', () => {
    const records = Array.from({ length: POLICY.request.maxRecordsPerPush + 1 }, (_, i) =>
      record(`r${i}`, 'AAAA'),
    );
    expect(splitIntoBatches(records).map((batch) => batch.length)).toEqual([
      POLICY.request.maxRecordsPerPush,
      1,
    ]);
  });

  it('stay within pushBatchBytes, and one largest record goes alone', () => {
    const largest = 'A'.repeat(POLICY.record.maxCiphertextBytes);
    const batches = splitIntoBatches([1, 2, 3].map((i) => record(`r${i}`, largest)));
    expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
    for (const batch of batches) {
      expect(JSON.stringify({ records: batch }).length).toBeLessThanOrEqual(
        POLICY.request.pushBatchBytes,
      );
    }
    expect(recordBytes(record('x', largest))).toBeLessThan(POLICY.request.pushBatchBytes);
  });
});

describe('record ids', () => {
  it('follow the rules of spec 4.5', () => {
    expect(isValidRecordId('session', 'a'.repeat(64), false)).toBe(true);
    expect(isValidRecordId('session', 'a'.repeat(65), false)).toBe(false);
    expect(isValidRecordId('doc', 'a'.repeat(43), true)).toBe(true);
    expect(isValidRecordId('doc', 'a'.repeat(42), false)).toBe(false);
    expect(isValidRecordId('settings', 'settings', false)).toBe(true);
    expect(isValidRecordId('settings', 'settings', true)).toBe(false);
  });
});

describe('tombstones', () => {
  it('of a session, a screenshot and a doc stay under maxTombstoneChars', async () => {
    const meta = {
      kind: 'session',
      id: 'x'.repeat(64),
      updatedAt: Number.MAX_SAFE_INTEGER,
      deleted: true,
    } as const;
    expect((await encryptRecord(DEK, meta, { deleted: true })).ciphertext.length).toBeLessThan(
      POLICY.record.maxTombstoneChars,
    );
    const doc = {
      type: 'youtubeNote',
      version: 1,
      data: { id: 'x'.repeat(64), videoId: 'v'.repeat(11) },
    };
    expect(
      (await encryptRecord(DEK, { ...meta, kind: 'doc', id: 'y'.repeat(43) }, doc)).ciphertext
        .length,
    ).toBeLessThan(POLICY.record.maxTombstoneChars);
  });
});

it('waits for an answer within the worker’s bound', () => {
  expect(answerTimeoutMs(POLICY.request.pushBatchBytes, true)).toBe(POLICY.request.answerTimeoutMs);
  expect(answerTimeoutMs(POLICY.request.pushBatchBytes, false)).toBeLessThanOrEqual(
    POLICY.request.pageTotalTimeoutMs,
  );
});
