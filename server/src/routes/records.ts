import type { AppHandler, Deps } from '../context.js';
import { error, json } from '../responses.js';
import type { StoredRecord } from '../types.js';
import { parseRecordsBody, parseRecordsQuery } from '../validation.js';

export function getRecords(deps: Deps): AppHandler {
  return async (c) => {
    // URLSearchParams, not c.req.query(), whose decoding differs.
    const query = parseRecordsQuery(new URL(c.req.url).searchParams);
    if (query === null) {
      return error(400, 'bad_request');
    }
    // One extra row says whether there is more without a second query.
    const { since, limit, kinds } = query;
    const rows = await deps.store.listRecords(c.get('user').id, since, limit + 1, kinds);
    const hasMore = rows.length > limit;
    const records: StoredRecord[] = hasMore ? rows.slice(0, limit) : rows;
    const next = records.length > 0 ? records[records.length - 1].seq : since;
    return json(200, { records, next, hasMore });
  };
}

export function postRecords(deps: Deps): AppHandler {
  return async (c) => {
    const records = parseRecordsBody(c.get('body'));
    if (records === null) {
      return error(400, 'bad_request');
    }
    const userId = c.get('user').id;
    const results = [];
    // In order, one statement each: a later record with the same (kind, id) sees the earlier one.
    for (const record of records) {
      const result = await deps.store.applyRecord(userId, record);
      const { kind, id } = record;
      if (result.status === 'applied') {
        results.push({ kind, id, status: 'applied', seq: result.seq });
      } else if (result.status === 'stale') {
        results.push({ kind, id, status: 'stale', current: result.current });
      } else {
        // Over a per-account limit: nothing stored, the client keeps it and says so.
        results.push({ kind, id, status: 'rejected', reason: result.reason });
      }
    }
    return json(200, { results });
  };
}
