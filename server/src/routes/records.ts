import { POLICY } from '../../../src/constants.js';
import type { AppHandler, Deps } from '../context.js';
import { error, json, ndjson } from '../responses.js';
import { createPullStream } from '../stream.js';
import type { RecordIn, WriteResult } from '../types.js';
import { isClockAhead, parseRecordsBody, parseSince, storedBytesOf } from '../validation.js';

/** Why a fence failed after the key header passed: the account went, or its key changed. */
async function fenceFailure(deps: Deps, accountId: string): Promise<Response> {
  const state = await deps.store.readKeyState(accountId);
  if (state === null) {
    return error(401, 'unauthorized');
  }
  return state.keyId === null ? error(409, 'key_missing') : error(409, 'key_mismatch');
}

/** `GET /v2/records?since=<n>`: every kind, streamed as NDJSON (spec 4.4). */
export function getRecords(deps: Deps): AppHandler {
  return async (c) => {
    // URLSearchParams, not c.req.query(), whose decoding differs. Unknown parameters are ignored.
    const since = parseSince(new URL(c.req.url).searchParams);
    if (since === null) {
      return error(400, 'bad_request');
    }
    const accountId = c.get('account').id;
    const keyId = c.get('keyId');
    const start = await deps.store.streamStart(accountId, keyId);
    if (start === null) {
      return fenceFailure(deps, accountId);
    }
    return ndjson(
      createPullStream({
        store: deps.store,
        accountId,
        keyId,
        since,
        through: start.through,
        usage: start.usage,
        now: deps.now,
      }),
    );
  };
}

/** `POST /v2/records` (spec 4.5): one `apply_account_record()` per record, in request order. */
export function postRecords(deps: Deps): AppHandler {
  return async (c) => {
    const records = parseRecordsBody(c.get('body'));
    if (records === null) {
      return error(400, 'bad_request');
    }
    const accountId = c.get('account').id;
    const keyId = c.get('keyId');
    const results: WriteResult[] = [];
    let staleBytes = 0;
    for (const record of records) {
      const { kind, id } = record;
      if (isClockAhead(record.updatedAt, deps.now())) {
        results.push({ kind, id, status: 'rejected', reason: 'clock_ahead' });
        continue;
      }
      const result = await deps.store.applyRecord(accountId, keyId, record, storedBytesOf(record));
      switch (result.outcome) {
        case 'applied':
          results.push({ kind, id, status: 'applied', seq: result.seq });
          break;
        case 'absent':
          results.push({ kind, id, status: 'absent' });
          break;
        case 'image_limit':
        case 'storage_limit':
          results.push({ kind, id, status: 'rejected', reason: result.outcome });
          break;
        case 'no_account':
          // Earlier records of this request stay written, as after any lost answer.
          return error(401, 'unauthorized');
        case 'key_missing':
        case 'key_mismatch':
          return error(409, result.outcome);
        case 'stale': {
          const stale = await staleResult(deps, accountId, record, staleBytes);
          if (stale === null) {
            return error(401, 'unauthorized');
          }
          staleBytes += stale.bytes;
          results.push(stale.result);
          break;
        }
      }
    }
    const usage = await deps.store.usage(accountId);
    if (usage === null) {
      return error(401, 'unauthorized');
    }
    return json(200, { results, usage });
  };
}

/**
 * The stale answer, with the row that won read in a statement of its own (a fresh snapshot).
 * `current` bodies stop at `POLICY.request.maxStaleBytes`, the first always sent, so the JSON
 * answer stays under Vercel's limit. Null: a non-doc row is gone, which only an account deletion
 * does.
 */
async function staleResult(
  deps: Deps,
  accountId: string,
  record: RecordIn,
  bytesSoFar: number,
): Promise<{ result: WriteResult; bytes: number } | null> {
  const { kind, id } = record;
  const current = await deps.store.readRecord(accountId, kind, id);
  if (current === null) {
    return kind === 'doc'
      ? { result: { kind, id, status: 'stale', current: null }, bytes: 0 }
      : null;
  }
  const bytes = JSON.stringify(current).length;
  if (bytesSoFar > 0 && bytesSoFar + bytes > POLICY.request.maxStaleBytes) {
    return { result: { kind, id, status: 'stale', withheld: true }, bytes: 0 };
  }
  return { result: { kind, id, status: 'stale', current }, bytes };
}
