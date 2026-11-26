import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';

// The numbers are written out here on purpose: changing a policy has to be a visible change. The
// checks that the client and the server each draw their lines at these values are in
// policy-client.test.ts and server/src/tests/policy-server.test.ts.

const MIB = 1_048_576;
/** Vercel's limit on a function's request and non-streamed answer body. */
const VERCEL_BODY_BYTES = 4_500_000;
/** The sync function's `maxDuration` in server/vercel.json. */
const FUNCTION_MAX_MS = 300_000;
/** Chrome stops a fetch in an extension service worker after this. */
const WORKER_FETCH_MS = 30_000;

it('POLICY holds these numbers', () => {
  expect(POLICY).toEqual({
    account: { storageBytes: 52_428_800, screenshots: 100 },
    record: {
      maxCiphertextBytes: 1_048_576,
      maxTombstoneChars: 512,
      overheadBytes: 128,
      maxClockAheadMs: 86_400_000,
    },
    request: {
      maxRecordsPerPush: 100,
      maxBodyBytes: 4_194_304,
      maxSmallBodyBytes: 16_384,
      pushBatchBytes: 2_097_152,
      maxStaleBytes: 3_145_728,
      maxAccessTokenChars: 4096,
      answerTimeoutMs: 25_000,
      pageUploadBytesPerMs: 64,
      pageTotalTimeoutMs: 120_000,
      databaseTimeoutMs: 15_000,
      googleTimeoutMs: 10_000,
    },
    pull: {
      batchBytes: 2_097_152,
      batchRecords: 200,
      streamMs: 120_000,
      readIdleMs: 25_000,
      bufferBytes: 8_388_608,
      bufferRecords: 1000,
      maxRequestsPerRun: 20,
    },
    passphrase: { minLength: 8 },
    kdf: {
      iterations: 600_000,
      saltBytes: 16,
    },
    signIn: { tokenLifetimeMs: 7_776_000_000 },
    sync: {
      periodMinutes: 15,
      debounceMs: 2500,
      maxWaitMs: 10_000,
      fallbackMs: 30_000,
      keepAliveMs: 20_000,
      sentVersions: 4,
    },
    memo: { autosaveMs: 1000, titleChars: 120 },
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

describe('the numbers fit each other', () => {
  it('sends batches below the body the server reads, and that below Vercel', () => {
    expect(POLICY.request.pushBatchBytes).toBeLessThan(POLICY.request.maxBodyBytes);
    expect(POLICY.request.maxBodyBytes).toBeLessThan(VERCEL_BODY_BYTES);
    expect(POLICY.request.maxStaleBytes + MIB).toBeLessThan(VERCEL_BODY_BYTES);
  });

  it('fits one largest record in one push batch', () => {
    const largest = {
      kind: 'session',
      id: 'x'.repeat(64),
      updatedAt: Number.MAX_SAFE_INTEGER,
      deleted: false,
      iv: 'A'.repeat(16),
      ciphertext: 'A'.repeat(POLICY.record.maxCiphertextBytes),
      baseSeq: Number.MAX_SAFE_INTEGER,
    };
    expect(JSON.stringify({ records: [largest] }).length).toBeLessThanOrEqual(
      POLICY.request.pushBatchBytes,
    );
  });

  it("keeps a stream batch and one more record inside the reader's bounds", () => {
    expect(POLICY.pull.batchBytes + POLICY.record.maxCiphertextBytes).toBeLessThanOrEqual(
      POLICY.pull.bufferBytes,
    );
    expect(POLICY.pull.batchRecords).toBeLessThanOrEqual(POLICY.pull.bufferRecords);
  });

  it('ends a stream before the function is stopped, and a worker request before Chrome stops it', () => {
    expect(POLICY.pull.streamMs).toBeLessThan(FUNCTION_MAX_MS);
    expect(POLICY.request.answerTimeoutMs).toBeLessThan(WORKER_FETCH_MS);
    expect(POLICY.pull.readIdleMs).toBeLessThan(WORKER_FETCH_MS);
    expect(POLICY.sync.keepAliveMs).toBeLessThan(WORKER_FETCH_MS);
    expect(POLICY.sync.fallbackMs).toBeGreaterThanOrEqual(30_000);
  });

  it("leaves room for every collection's tombstone", () => {
    // The largest deleted data any collection has: a YouTube note's `{ id, videoId }`, wrapped in
    // `{type, version, data}`, JSON, AES-GCM (16 bytes of tag) and base64.
    const plain = JSON.stringify({
      type: 'youtubeNote',
      version: 1,
      data: { id: 'x'.repeat(64), videoId: 'x'.repeat(11) },
    });
    const chars = Math.ceil((plain.length + 16) / 3) * 4;
    expect(chars).toBeLessThan(POLICY.record.maxTombstoneChars);
  });

  it('counts every row at least as a tombstone', () => {
    expect(POLICY.record.maxTombstoneChars).toBeLessThan(POLICY.record.maxCiphertextBytes);
    expect(POLICY.record.overheadBytes).toBeGreaterThan(0);
  });
});
