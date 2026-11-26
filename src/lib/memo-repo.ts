import { POLICY } from '@/constants';
import { memoCopyId } from '@/lib/cloud-crypto';
import {
  type DocCollection,
  type DocStore,
  type DocTx,
  type LocalDoc,
  trackLocalDocChange,
} from '@/lib/cloud-docs';
import { allLocalKeys, runDocTransaction } from '@/lib/doc-store-tx';
import { isRecord } from '@/lib/import-guards';
import { MalformedRecordError, UnknownSchemaVersionError } from '@/lib/session-migrate';
import type { CloudSyncMeta, Memo, MemoDraft, MemoSummary } from '@/types';

/**
 * Free-form memos in `chrome.storage.local` (spec 11.4): the ONLY writer of the memo keys, under
 * a Web Lock of its own (`tabinet:memos`), then the sessions lock while sync is configured.
 *
 * - `memo:<id>`: one `Memo` body.
 * - `memoIndex`: `{ schemaVersion: 1, memos: MemoSummary[] }`, newest `updatedAt` first.
 * - `memoDraft:<editorId>`: what an editor held when its page went away (`pagehide`), written by
 *   the page itself synchronously and adopted here by `adoptDrafts()`.
 *
 * Every change is one `set`: the body (or `null`), the index and the sync bookkeeping together
 * (invariant 12). Saves are decided by the editor's precondition, the text it last saw saved
 * (`expected`), never by a stamp: a memo changed elsewhere meanwhile is never written over; the
 * editor's text goes to a copy (`conflictOf`) instead. Synced as `memo` docs (`memoStore`),
 * `keepBoth`: a conflict keeps both texts.
 */

export const MEMO_INDEX_KEY = 'memoIndex';
export const MEMOS_LOCK_NAME = 'tabinet:memos';

const MEMO_KEY_PREFIX = 'memo:';
const DRAFT_KEY_PREFIX = 'memoDraft:';
const MEMO_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function memoKey(id: string): string {
  return `${MEMO_KEY_PREFIX}${id}`;
}

export function memoDraftKey(editorId: string): string {
  return `${DRAFT_KEY_PREFIX}${editorId}`;
}

export function isMemoDraftKey(key: string): boolean {
  return key.startsWith(DRAFT_KEY_PREFIX);
}

/** A fresh memo id, made when an editor opens (nothing is stored until its first save). */
export function newMemoId(): string {
  return crypto.randomUUID();
}

/** Whether `id` can be a memo id (`[A-Za-z0-9_-]{1,64}`). Pure. */
export function isMemoId(id: string): boolean {
  return ID.test(id);
}

/**
 * The title shown for a memo: its first non-blank line, trimmed, at most
 * `POLICY.memo.titleChars` code points; `''` when the text is blank ("Untitled memo"). Pure.
 */
export function memoTitle(text: string): string {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) {
    return '';
  }
  return Array.from(line.trim()).slice(0, POLICY.memo.titleChars).join('');
}

// ---------------------------------------------------------------------------
// Validation (stored data is read back, never trusted)
// ---------------------------------------------------------------------------

/** A stored body, checked; a future schema throws `UnknownSchemaVersionError`. */
export function parseMemo(value: unknown, id?: string): Memo {
  if (!isRecord(value)) {
    throw new MalformedRecordError('Memo body is not an object');
  }
  if (value.schemaVersion !== MEMO_SCHEMA_VERSION) {
    throw new UnknownSchemaVersionError(value.schemaVersion);
  }
  if (
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    (id !== undefined && value.id !== id) ||
    typeof value.text !== 'string' ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    (value.conflictOf !== undefined &&
      (typeof value.conflictOf !== 'string' || !ID.test(value.conflictOf)))
  ) {
    throw new MalformedRecordError('Memo body is malformed');
  }
  const memo: Memo = {
    schemaVersion: MEMO_SCHEMA_VERSION,
    id: value.id,
    text: value.text,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.conflictOf !== undefined) {
    memo.conflictOf = value.conflictOf;
  }
  return memo;
}

function isSummary(value: unknown): value is MemoSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.conflict === 'boolean'
  );
}

interface MemoIndex {
  schemaVersion: 1;
  memos: MemoSummary[];
}

function parseIndex(value: unknown): MemoIndex {
  if (value === undefined || value === null) {
    return { schemaVersion: MEMO_SCHEMA_VERSION, memos: [] };
  }
  if (!isRecord(value)) {
    throw new MalformedRecordError('Memo index is not an object');
  }
  if (value.schemaVersion !== MEMO_SCHEMA_VERSION) {
    throw new UnknownSchemaVersionError(value.schemaVersion);
  }
  if (!Array.isArray(value.memos) || !value.memos.every(isSummary)) {
    throw new MalformedRecordError('Memo index is malformed');
  }
  return { schemaVersion: MEMO_SCHEMA_VERSION, memos: value.memos };
}

/** A stored draft, or `null` when it is not one this build can read. Pure. */
export function parseMemoDraft(value: unknown): MemoDraft | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== MEMO_SCHEMA_VERSION ||
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    typeof value.text !== 'string' ||
    !Array.isArray(value.bases) ||
    !value.bases.every((base) => base === null || typeof base === 'string') ||
    typeof value.at !== 'number'
  ) {
    return null;
  }
  return {
    schemaVersion: MEMO_SCHEMA_VERSION,
    id: value.id,
    text: value.text,
    bases: value.bases as (string | null)[],
    at: value.at,
  };
}

export function toMemoSummary(memo: Memo): MemoSummary {
  return {
    id: memo.id,
    title: memoTitle(memo.text),
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt,
    conflict: memo.conflictOf !== undefined,
  };
}

function sortedSummaries(memos: readonly MemoSummary[]): MemoSummary[] {
  return [...memos].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// The synced collection (11.4)
// ---------------------------------------------------------------------------

/** A memo as it is synced: `updatedAt` is the record's, never in the data. */
export interface MemoLive {
  id: string;
  text: string;
  createdAt: number;
  conflictOf?: string;
}

function exactKeys(value: Record<string, unknown>, keys: string[], optional: string[]): boolean {
  const own = Object.keys(value);
  return (
    keys.every((key) => own.includes(key)) &&
    own.every((key) => keys.includes(key) || optional.includes(key))
  );
}

export const memoCollection: DocCollection<MemoLive, { id: string }> = {
  type: 'memo',
  version: 1,
  conflict: 'keepBoth',
  parseLive(data) {
    if (
      !isRecord(data) ||
      !exactKeys(data, ['id', 'text', 'createdAt'], ['conflictOf']) ||
      typeof data.id !== 'string' ||
      !ID.test(data.id) ||
      typeof data.text !== 'string' ||
      typeof data.createdAt !== 'number' ||
      !Number.isFinite(data.createdAt) ||
      (data.conflictOf !== undefined &&
        (typeof data.conflictOf !== 'string' || !ID.test(data.conflictOf)))
    ) {
      return null;
    }
    const live: MemoLive = { id: data.id, text: data.text, createdAt: data.createdAt };
    if (data.conflictOf !== undefined) {
      live.conflictOf = data.conflictOf;
    }
    return live;
  },
  parseDeleted(data) {
    return isRecord(data) &&
      exactKeys(data, ['id'], []) &&
      typeof data.id === 'string' &&
      ID.test(data.id)
      ? { id: data.id }
      : null;
  },
  deletedOf: (id) => ({ id }),
  fingerprint: (data) => [data.text],
  keepBoth: {
    textOf: (data) => data.text,
    makeCopy: (data, copyId, originalId, now) => ({
      id: copyId,
      text: data.text,
      createdAt: now,
      conflictOf: originalId,
    }),
  },
};

function liveOf(memo: Memo): MemoLive {
  const live: MemoLive = { id: memo.id, text: memo.text, createdAt: memo.createdAt };
  if (memo.conflictOf !== undefined) {
    live.conflictOf = memo.conflictOf;
  }
  return live;
}

function memoOf(live: MemoLive, updatedAt: number): Memo {
  const memo: Memo = {
    schemaVersion: MEMO_SCHEMA_VERSION,
    id: live.id,
    text: live.text,
    createdAt: live.createdAt,
    updatedAt,
  };
  if (live.conflictOf !== undefined) {
    memo.conflictOf = live.conflictOf;
  }
  return memo;
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

interface MemoTx extends DocTx<MemoLive, { id: string }> {
  /** The stored memo (staged changes included), or `null`; throws when it cannot be read. */
  memo(id: string): Promise<Memo | null>;
}

function transact<T>(run: (tx: MemoTx) => Promise<T>): Promise<T> {
  return runDocTransaction(MEMOS_LOCK_NAME, async (meta: CloudSyncMeta) => {
    const staged = new Map<string, unknown>();
    const readKey = async (key: string): Promise<unknown> =>
      staged.has(key) ? staged.get(key) : (await chrome.storage.local.get(key))[key];
    const memo = async (id: string): Promise<Memo | null> => {
      const value = await readKey(memoKey(id));
      return value === undefined || value === null ? null : parseMemo(value, id);
    };
    const read = async (id: string): Promise<LocalDoc<MemoLive>> => {
      try {
        const found = await memo(id);
        return found === null
          ? { state: 'none' }
          : { state: 'live', data: liveOf(found), at: found.updatedAt };
      } catch {
        return { state: 'unreadable' };
      }
    };
    const listLive = async (): Promise<{ data: MemoLive; at: number }[]> => {
      const keys = new Set([...(await allLocalKeys()), ...staged.keys()]);
      const out: { data: MemoLive; at: number }[] = [];
      for (const key of keys) {
        if (key.startsWith(MEMO_KEY_PREFIX)) {
          const local = await read(key.slice(MEMO_KEY_PREFIX.length));
          if (local.state === 'live') {
            out.push({ data: local.data, at: local.at });
          }
        }
      }
      return out;
    };
    const tx: MemoTx = {
      meta,
      memo,
      read,
      listLive,
      put(data, at) {
        staged.set(memoKey(data.id), memoOf(data, at));
      },
      remove(deleted) {
        staged.set(memoKey(deleted.id), null);
      },
      stage(key, value) {
        staged.set(key, value);
      },
    };
    const result = await run(tx);
    const entries: Record<string, unknown> = Object.fromEntries(staged);
    const changed = [...staged.keys()].filter((key) => key.startsWith(MEMO_KEY_PREFIX));
    if (changed.length > 0 && !staged.has(MEMO_INDEX_KEY)) {
      const raw: Record<string, unknown> = await chrome.storage.local.get(MEMO_INDEX_KEY);
      const index = parseIndex(raw[MEMO_INDEX_KEY]);
      const touched = new Set(changed.map((key) => key.slice(MEMO_KEY_PREFIX.length)));
      const summaries = index.memos.filter((summary) => !touched.has(summary.id));
      for (const key of changed) {
        const value = staged.get(key);
        if (value !== null && value !== undefined) {
          summaries.push(toMemoSummary(value as Memo));
        }
      }
      entries[MEMO_INDEX_KEY] = {
        schemaVersion: MEMO_SCHEMA_VERSION,
        memos: sortedSummaries(summaries),
      } satisfies MemoIndex;
    }
    return { result, entries };
  });
}

/** Writes `text` into the memo `id` (new or not), tracked; returns the memo written. */
function writeMemo(
  tx: MemoTx,
  id: string,
  text: string,
  before: Memo | null,
  now: number,
  conflictOf?: string,
): Memo {
  const live: MemoLive = {
    id,
    text,
    createdAt: before?.createdAt ?? now,
  };
  const keptConflict = before?.conflictOf ?? conflictOf;
  if (keptConflict !== undefined) {
    live.conflictOf = keptConflict;
  }
  const at = trackLocalDocChange(tx, memoCollection, {
    localId: id,
    before: before === null ? null : liveOf(before),
    after: { live },
    previousAt: before?.updatedAt ?? 0,
    now,
  });
  tx.put(live, at);
  return memoOf(live, at);
}

/** The copy of `text` taken from `id` by the copy-id rule (11.4): the same one everywhere. */
async function copyFor(tx: MemoTx, originalId: string, text: string, now: number): Promise<Memo> {
  for (let n = 0; ; n += 1) {
    const candidate = await memoCopyId(originalId, text, n);
    const local = await tx.read(candidate);
    if (local.state === 'live' && local.data.text === text) {
      return memoOf(local.data, local.at);
    }
    if (
      local.state === 'none' &&
      tx.meta.docs[`${memoCollection.type}:${candidate}`] === undefined
    ) {
      const written = writeMemo(tx, candidate, text, null, now, originalId);
      if (tx.meta.started.includes(memoCollection.type)) {
        tx.meta.conflicts += 1;
      }
      return written;
    }
  }
}

export type MemoSaveOutcome = 'saved' | 'unchanged' | 'redirected' | 'copied';

export interface MemoSaveInput {
  id: string;
  text: string;
  /** The text the editor last saw saved, then every text whose save it started and did not see confirmed; `null`: no memo yet. */
  expected: readonly (string | null)[];
}

/** The save rule (11.4, steps 1 to 5), inside a transaction. */
async function saveIn(
  tx: MemoTx,
  input: MemoSaveInput,
  now: number,
): Promise<{ outcome: MemoSaveOutcome; memo: Memo }> {
  const before = await tx.memo(input.id);
  const current = before === null ? null : before.text;
  if (before !== null && current === input.text) {
    return { outcome: 'unchanged', memo: before };
  }
  if (input.expected.includes(current)) {
    return { outcome: 'saved', memo: writeMemo(tx, input.id, input.text, before, now) };
  }
  for (const { data, at } of await tx.listLive()) {
    if (data.conflictOf === input.id && input.expected.includes(data.text)) {
      if (data.text === input.text) {
        return { outcome: 'redirected', memo: memoOf(data, at) };
      }
      const copy = memoOf(data, at);
      return { outcome: 'redirected', memo: writeMemo(tx, data.id, input.text, copy, now) };
    }
  }
  return { outcome: 'copied', memo: await copyFor(tx, input.id, input.text, now) };
}

export const memoRepo = {
  /** Every memo, newest first. */
  async listSummaries(): Promise<MemoSummary[]> {
    const raw: Record<string, unknown> = await chrome.storage.local.get(MEMO_INDEX_KEY);
    return parseIndex(raw[MEMO_INDEX_KEY]).memos;
  },

  /** One memo, `null` when there is none, `'unreadable'` when its body cannot be read here. */
  async get(id: string): Promise<Memo | null | 'unreadable'> {
    const key = memoKey(id);
    const raw: Record<string, unknown> = await chrome.storage.local.get(key);
    const value = raw[key];
    if (value === undefined || value === null) {
      return null;
    }
    try {
      return parseMemo(value, id);
    } catch {
      return 'unreadable';
    }
  },

  /**
   * Saves an editor's text (11.4): unchanged when the memo already holds it; written when the
   * memo still holds a text the editor expected; written into the conflict copy sync made of
   * this editor's text (`redirected`); otherwise a copy (`copied`). The editor follows the memo
   * returned. Rejects when the memo's body cannot be read here.
   */
  save(
    input: MemoSaveInput,
    now: number = Date.now(),
  ): Promise<{ outcome: MemoSaveOutcome; memo: Memo }> {
    return transact((tx) => saveIn(tx, input, now));
  },

  /** Deletes a memo and returns it (for an Undo), or `undefined` when it was gone. */
  remove(id: string, now: number = Date.now()): Promise<Memo | undefined> {
    return transact(async (tx) => {
      const before = await tx.memo(id);
      if (before === null) {
        return undefined;
      }
      const at = trackLocalDocChange(tx, memoCollection, {
        localId: id,
        before: liveOf(before),
        after: { deleted: { id } },
        previousAt: before.updatedAt,
        now,
      });
      tx.remove({ id }, at);
      return before;
    });
  },

  /**
   * Puts a deleted memo back (Undo) with a new stamp, above its deletion. When a different text
   * is at that id by now, the deleted text becomes a copy instead.
   */
  restore(memo: Memo, now: number = Date.now()): Promise<Memo> {
    return transact(async (tx) => {
      const current = await tx.memo(memo.id);
      if (current !== null) {
        return current.text === memo.text ? current : copyFor(tx, memo.id, memo.text, now);
      }
      const live = liveOf(memo);
      // Above the memo's own stamp and above its deletion (`nextDocStamp()`).
      const at = trackLocalDocChange(tx, memoCollection, {
        localId: memo.id,
        before: null,
        after: { live },
        previousAt: memo.updatedAt,
        now,
      });
      tx.put(live, at);
      return memoOf(live, at);
    });
  },

  /**
   * Adopts every draft an editor left on `pagehide` (12.1): the save rule with the draft's bases
   * as `expected`, and the draft removed in the same write. A draft the memo already holds is only
   * removed; a blank draft of a memo that was never saved too. Returns how many changed a memo.
   */
  adoptDrafts(now: number = Date.now()): Promise<number> {
    return transact(async (tx) => {
      const keys = (await allLocalKeys()).filter(isMemoDraftKey);
      if (keys.length === 0) {
        return 0;
      }
      const raw: Record<string, unknown> = await chrome.storage.local.get(keys);
      let adopted = 0;
      for (const key of keys) {
        const value = raw[key];
        if (value === undefined || value === null) {
          continue;
        }
        const draft = parseMemoDraft(value);
        if (draft === null) {
          // A draft this build cannot read is left for one that can.
          continue;
        }
        const local = await tx.read(draft.id);
        if (local.state === 'unreadable') {
          continue;
        }
        if (local.state === 'none' && draft.text.trim() === '') {
          tx.stage(key, null);
          continue;
        }
        const { outcome } = await saveIn(
          tx,
          { id: draft.id, text: draft.text, expected: draft.bases },
          now,
        );
        if (outcome !== 'unchanged') {
          adopted += 1;
        }
        tx.stage(key, null);
      }
      return adopted;
    });
  },

  /**
   * The repair pass: removes `null` bodies left by an interrupted cleanup, re-indexes bodies the
   * index lacks or no longer matches, drops entries without a body. A body this build cannot read
   * keeps the entry it had (it is shown as unreadable), and is never written.
   */
  reconcile(): Promise<{ reindexed: number; dropped: number }> {
    return transact(async (tx) => {
      const keys = (await allLocalKeys()).filter((key) => key.startsWith(MEMO_KEY_PREFIX));
      const raw: Record<string, unknown> = await chrome.storage.local.get([
        MEMO_INDEX_KEY,
        ...keys,
      ]);
      let index: MemoIndex;
      let broken = false;
      try {
        index = parseIndex(raw[MEMO_INDEX_KEY]);
      } catch {
        index = { schemaVersion: MEMO_SCHEMA_VERSION, memos: [] };
        broken = true;
      }
      const listed = new Map(index.memos.map((summary) => [summary.id, summary]));
      const summaries: MemoSummary[] = [];
      let reindexed = 0;
      for (const key of keys) {
        const id = key.slice(MEMO_KEY_PREFIX.length);
        const value = raw[key];
        if (value === null) {
          tx.stage(key, null);
          continue;
        }
        try {
          const summary = toMemoSummary(parseMemo(value, id));
          if (JSON.stringify(listed.get(id)) !== JSON.stringify(summary)) {
            reindexed += 1;
          }
          summaries.push(summary);
        } catch {
          const kept = listed.get(id);
          if (kept !== undefined) {
            summaries.push(kept);
          }
        }
      }
      const present = new Set(summaries.map((summary) => summary.id));
      const dropped = index.memos.filter((summary) => !present.has(summary.id)).length;
      if (reindexed > 0 || dropped > 0 || broken) {
        tx.stage(MEMO_INDEX_KEY, {
          schemaVersion: MEMO_SCHEMA_VERSION,
          memos: sortedSummaries(summaries),
        } satisfies MemoIndex);
      }
      return { reindexed, dropped };
    });
  },
};

/** The memo collection's store, for the sync engine (`DOC_STORES`). */
export const memoStore: DocStore<MemoLive, { id: string }> = {
  collection: memoCollection,
  transact: (run) => transact(run),
};
