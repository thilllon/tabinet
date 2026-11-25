/**
 * The streaming check of the cutover runbook (spec 15.2, step 12), run by the owner against the
 * deployed server with a freshly created account:
 *
 *   pnpm --filter tabinet-server stream-check
 *
 * It asks for the bearer and the key id without echoing them, talks only to the API base the
 * extension ships with (`CLOUD_SYNC.apiBase`; `API` may name it, never another), refuses an
 * account already holding more than 5 MiB, then: writes 40 junk docs of 1 MiB of random
 * ciphertext; pulls from 0 and cuts the connection after about 10 MiB; resumes from the last
 * checkpoint it saw and reads to an end line with `complete: true` and `cursor === through`;
 * starts a third pull and cancels it after the first batch; and tombstones all 40. It prints
 * counts, byte totals and timings only. The junk cannot be read by any extension (it is random).
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { CLOUD_SYNC, POLICY } from '../../src/constants.js';
import type { PullLine, Usage, WireKey, WriteResult } from '../src/types.js';

const MIB = 2 ** 20;
const JUNK_RECORDS = 40;
/** The account may hold no more than this before the check starts. */
const MAX_START_BYTES = 5 * MIB;
/** Where the first pull is cut. */
const CUT_AFTER_BYTES = 10 * MIB;

export interface StreamCheckOptions {
  apiBase: string;
  token: string;
  keyId: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
}

interface PullResult {
  bytes: number;
  records: number;
  lastCheckpoint: number | null;
  start: Extract<PullLine, { type: 'start' }> | null;
  end: Extract<PullLine, { type: 'end' }> | null;
}

export async function runStreamCheck(options: StreamCheckOptions): Promise<void> {
  const send = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    'Tabinet-Key-Id': options.keyId,
  };
  const url = (path: string) => `${options.apiBase}${path}`;

  const meRes = await send(url('/v2/me'), { headers });
  if (meRes.status !== 200) {
    throw new Error(`GET /v2/me answered ${meRes.status}`);
  }
  const me = (await meRes.json()) as { key: WireKey; usage: Usage };
  if (me.key?.keyId !== options.keyId) {
    throw new Error('The key id is not the account key');
  }
  if (me.usage.bytes > MAX_START_BYTES) {
    throw new Error('Refusing: the account already holds more than 5 MiB');
  }
  log(`Start: ${me.usage.bytes} bytes in the account`);

  // 1. Junk docs: random ids, 1 MiB of random ciphertext each, one per request.
  const junkBytes = (POLICY.record.maxCiphertextBytes / 4) * 3;
  const written: { id: string; seq: number; updatedAt: number }[] = [];
  let started = now();
  for (let n = 0; n < JUNK_RECORDS; n++) {
    const record = {
      kind: 'doc',
      id: randomBytes(32).toString('base64url'),
      updatedAt: now(),
      deleted: false,
      iv: randomBytes(12).toString('base64'),
      ciphertext: randomBytes(junkBytes).toString('base64'),
      baseSeq: null,
    };
    const result = await post(send, url('/v2/records'), headers, record);
    if (result.status !== 'applied') {
      throw new Error(`Junk record ${n + 1} was ${result.status}`);
    }
    written.push({ id: record.id, seq: result.seq, updatedAt: record.updatedAt });
  }
  log(
    `Wrote ${JUNK_RECORDS} records of ${POLICY.record.maxCiphertextBytes} bytes in ${now() - started} ms`,
  );

  try {
    // 2. A pull from 0, cut after about 10 MiB.
    started = now();
    const cut = await pull(
      send,
      url('/v2/records?since=0'),
      headers,
      (r) => r.bytes >= CUT_AFTER_BYTES,
    );
    if (cut.lastCheckpoint === null || cut.end !== null) {
      throw new Error('The first pull ended before it could be cut');
    }
    log(`Cut a pull after ${cut.bytes} bytes and ${cut.records} records in ${now() - started} ms`);

    // 3. Resume from the last checkpoint and read to the end.
    started = now();
    let since = cut.lastCheckpoint;
    let requests = 0;
    let total = 0;
    let through: number | null = null;
    for (;;) {
      requests += 1;
      const rest = await pull(send, url(`/v2/records?since=${since}`), headers, () => false);
      total += rest.records;
      if (rest.end === null || rest.start === null) {
        throw new Error('A resumed pull ended without an end line');
      }
      through ??= rest.start.through;
      if (rest.end.complete) {
        if (rest.end.cursor !== rest.start.through) {
          throw new Error('The end cursor is not the start line through');
        }
        break;
      }
      if (requests >= POLICY.pull.maxRequestsPerRun) {
        throw new Error('The pull did not complete within maxRequestsPerRun requests');
      }
      since = rest.end.cursor;
    }
    log(`Resumed and completed in ${requests} requests, ${total} records, ${now() - started} ms`);

    // 4. A third pull, cancelled after its first batch.
    started = now();
    const cancelled = await pull(
      send,
      url('/v2/records?since=0'),
      headers,
      (r) => r.lastCheckpoint !== null,
    );
    log(
      `Cancelled a pull after its first batch: ${cancelled.records} records, ${now() - started} ms`,
    );
  } finally {
    // 5. Tombstones for all 40, whatever happened above.
    started = now();
    let deleted = 0;
    for (const junk of written) {
      const tombstone = {
        kind: 'doc',
        id: junk.id,
        updatedAt: Math.max(now(), junk.updatedAt + 1),
        deleted: true,
        iv: randomBytes(12).toString('base64'),
        ciphertext: randomBytes(32).toString('base64'),
        baseSeq: junk.seq,
      };
      const result = await post(send, url('/v2/records'), headers, tombstone);
      if (result.status === 'applied') {
        deleted += 1;
      }
    }
    log(`Tombstoned ${deleted} of ${written.length} records in ${now() - started} ms`);
  }
}

async function post(
  send: typeof fetch,
  target: string,
  headers: Record<string, string>,
  record: object,
): Promise<WriteResult & { seq: number }> {
  const res = await send(target, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [record] }),
  });
  if (res.status !== 200) {
    throw new Error(`POST /v2/records answered ${res.status}`);
  }
  const { results } = (await res.json()) as { results: (WriteResult & { seq: number })[] };
  return results[0];
}

/** Reads a pull line by line until its end, or until `stop` says to cut it there. */
async function pull(
  send: typeof fetch,
  target: string,
  headers: Record<string, string>,
  stop: (sofar: PullResult) => boolean,
): Promise<PullResult> {
  const controller = new AbortController();
  const res = await send(target, { headers, signal: controller.signal });
  if (res.status !== 200 || res.body === null) {
    throw new Error(`GET /v2/records answered ${res.status}`);
  }
  const result: PullResult = { bytes: 0, records: 0, lastCheckpoint: null, start: null, end: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return result;
    }
    result.bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const text of lines) {
      const line = JSON.parse(text) as PullLine;
      if (line.type === 'start') {
        result.start = line;
      } else if (line.type === 'record') {
        result.records += 1;
      } else if (line.type === 'checkpoint') {
        result.lastCheckpoint = line.cursor;
      } else {
        result.end = line;
      }
    }
    if (result.end === null && stop(result)) {
      await reader.cancel();
      controller.abort();
      return result;
    }
  }
}

/** Reads one line from the terminal without echoing it. */
async function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    throw new Error('Run this in a terminal: the bearer and key id are read without echo');
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          process.exit(130);
        }
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const apiBase = process.env.API ?? CLOUD_SYNC.apiBase;
  if (apiBase !== CLOUD_SYNC.apiBase || apiBase === '') {
    console.error('Refusing: the API base is not the one the extension ships with');
    process.exit(1);
  }
  const token = await promptHidden('Bearer (cloudAccountV2.token): ');
  const keyId = await promptHidden('Key id (cloudKeyV2.keyId): ');
  try {
    await runStreamCheck({ apiBase, token, keyId });
    console.log('Stream check passed');
  } catch (err) {
    // The message only: none of them holds the bearer.
    console.error('Stream check failed:', err instanceof Error ? err.message : typeof err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
