/**
 * The body of `GET /v2/records` (spec 4.4): NDJSON, `start (record+ checkpoint)* end`, one
 * database batch per `pull()`. With a high-water mark of 0 nothing is queued ahead: a batch is
 * read only when the reader asks for more, so what the socket buffers is the only read-ahead, and a
 * 50 MiB account is never held in memory. A failure closes the stream without an end line, which
 * the client takes for a failed run; it is never passed to the adaptor, which would log it whole.
 */
import { POLICY } from '../../src/constants.js';
import type { Store } from './db/store.js';
import type { PullLine, Usage } from './types.js';

export interface PullOptions {
  store: Store;
  accountId: string;
  keyId: string;
  since: number;
  /** The account's `last_seq` when the answer started: fixed for the whole response. */
  through: number;
  usage: Usage;
  now(): number;
}

const encoder = new TextEncoder();

function line(value: PullLine): string {
  return `${JSON.stringify(value)}\n`;
}

function failed(reason: string): void {
  console.error('tabinet-server: pull stopped', reason);
}

export function createPullStream(options: PullOptions): ReadableStream<Uint8Array> {
  const { store, accountId, keyId, since, through, usage, now } = options;
  const startedAt = now();
  let cursor = since;
  let batches = 0;
  let cancelled = false;

  const close = (controller: ReadableStreamDefaultController<Uint8Array>, last?: PullLine) => {
    if (last !== undefined) {
      controller.enqueue(encoder.encode(line(last)));
    }
    controller.close();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(encoder.encode(line({ type: 'start', keyId, since, through, usage })));
      },

      async pull(controller) {
        if (batches > 0 && now() - startedAt >= POLICY.pull.streamMs) {
          close(controller, { type: 'end', cursor, complete: false });
          return;
        }
        let batch: Awaited<ReturnType<Store['streamBatch']>>;
        try {
          batch = await store.streamBatch(
            accountId,
            keyId,
            cursor,
            through,
            POLICY.pull.batchRecords,
            POLICY.pull.batchBytes,
          );
        } catch (err) {
          if (!cancelled) {
            // The name only: a database error can quote the statement and its parameters.
            failed(err instanceof Error ? err.name : typeof err);
            controller.close();
          }
          return;
        }
        if (cancelled) {
          return;
        }
        if (batch.status === 'fenced') {
          // The account is gone or its key changed while this stream ran.
          failed('fenced');
          controller.close();
          return;
        }
        const { records } = batch;
        if (records.length === 0) {
          close(controller, { type: 'end', cursor: Math.max(since, through), complete: true });
          return;
        }
        let text = '';
        for (const record of records) {
          text += line({ type: 'record', record });
        }
        cursor = records[records.length - 1].seq;
        text += line({ type: 'checkpoint', cursor, count: records.length });
        batches += 1;
        controller.enqueue(encoder.encode(text));
      },

      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}
