import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import {
  MEMO_INDEX_KEY,
  memoCollection,
  memoDraftKey,
  memoKey,
  memoRepo,
  memoTitle,
  parseMemoDraft,
} from '@/lib/memo-repo';
import type { Memo, MemoDraft } from '@/types';

import { getChromeFake } from './chrome-fake';
import vectors from './key-vectors.json';

const ID = '00000000-0000-4000-8000-000000000001';

function stored<T>(key: string): T | undefined {
  // CAST: the test reads back what the repository itself wrote.
  return getChromeFake().state.local.get(key) as T | undefined;
}

function recordWrites(): string[][] {
  const writes: string[][] = [];
  const local = chrome.storage.local;
  const set = local.set.bind(local);
  local.set = async (items: Record<string, unknown>) => {
    writes.push(Object.keys(items).sort());
    return set(items);
  };
  return writes;
}

describe('memoTitle', () => {
  it('is the first non-blank line, trimmed and cut to the policy length', () => {
    expect(memoTitle('\n\n  Groceries  \nmilk')).toBe('Groceries');
    expect(memoTitle('   \n\t')).toBe('');
    expect(Array.from(memoTitle('한'.repeat(500)))).toHaveLength(POLICY.memo.titleChars);
  });
});

describe('memoRepo.save (spec 11.4, rules 1 to 5)', () => {
  it('creates a memo from an editor that expected none, body and index in one write', async () => {
    const writes = recordWrites();
    const { outcome, memo } = await memoRepo.save({ id: ID, text: 'hello', expected: [null] }, 5);
    expect(outcome).toBe('saved');
    expect(memo).toEqual({ schemaVersion: 1, id: ID, text: 'hello', createdAt: 5, updatedAt: 5 });
    expect(writes).toEqual([[MEMO_INDEX_KEY, memoKey(ID)].sort()]);
    expect(await memoRepo.listSummaries()).toEqual([
      { id: ID, title: 'hello', createdAt: 5, updatedAt: 5, conflict: false },
    ]);
  });

  it('writes nothing when the memo already holds the text (rule 2)', async () => {
    await memoRepo.save({ id: ID, text: 'a', expected: [null] }, 5);
    const writes = recordWrites();
    const { outcome } = await memoRepo.save({ id: ID, text: 'a', expected: ['zzz'] }, 9);
    expect(outcome).toBe('unchanged');
    expect(writes).toEqual([]);
  });

  it('writes over a text the editor expected, moving the stamp forward (rule 3)', async () => {
    await memoRepo.save({ id: ID, text: 'a', expected: [null] }, 10);
    const { outcome, memo } = await memoRepo.save({ id: ID, text: 'ab', expected: ['a'] }, 4);
    expect(outcome).toBe('saved');
    expect(memo.updatedAt).toBe(11);
    expect(memo.createdAt).toBe(10);
  });

  it('accepts any text whose save started and was not confirmed (rule 3)', async () => {
    await memoRepo.save({ id: ID, text: 'a', expected: [null] }, 10);
    await memoRepo.save({ id: ID, text: 'ab', expected: ['a'] }, 11);
    const { outcome } = await memoRepo.save({ id: ID, text: 'abc', expected: ['a', 'ab'] }, 12);
    expect(outcome).toBe('saved');
  });

  it('makes a copy when the memo changed elsewhere meanwhile (rule 5), with the vector id', async () => {
    await memoRepo.save({ id: ID, text: 'theirs', expected: [null] }, 10);
    const { outcome, memo } = await memoRepo.save(
      { id: ID, text: 'hello\n', expected: ['mine before'] },
      20,
    );
    expect(outcome).toBe('copied');
    expect(memo.id).toBe(vectors.memoCopyId);
    expect(memo.conflictOf).toBe(ID);
    expect(stored<Memo>(memoKey(ID))?.text).toBe('theirs');
    expect((await memoRepo.listSummaries()).find((s) => s.id === memo.id)?.conflict).toBe(true);
  });

  it('makes the same copy again, never a second one', async () => {
    await memoRepo.save({ id: ID, text: 'theirs', expected: [null] }, 10);
    const first = await memoRepo.save({ id: ID, text: 'mine', expected: ['old'] }, 20);
    const again = await memoRepo.save({ id: ID, text: 'mine', expected: ['old'] }, 30);
    expect(again.memo.id).toBe(first.memo.id);
    expect(await memoRepo.listSummaries()).toHaveLength(2);
  });

  it('writes into the copy sync made of this editor text (rule 4)', async () => {
    await memoRepo.save({ id: ID, text: 'theirs', expected: [null] }, 10);
    const copy = await memoRepo.save({ id: ID, text: 'mine', expected: ['old'] }, 20);
    const { outcome, memo } = await memoRepo.save(
      { id: ID, text: 'mine, more', expected: ['old', 'mine'] },
      30,
    );
    expect(outcome).toBe('redirected');
    expect(memo.id).toBe(copy.memo.id);
    expect(memo.text).toBe('mine, more');
    expect(memo.conflictOf).toBe(ID);
    expect(await memoRepo.listSummaries()).toHaveLength(2);
  });

  it('copies an edit of a memo deleted elsewhere', async () => {
    await memoRepo.save({ id: ID, text: 'a', expected: [null] }, 10);
    await memoRepo.remove(ID, 11);
    const { outcome, memo } = await memoRepo.save({ id: ID, text: 'ab', expected: ['a'] }, 12);
    expect(outcome).toBe('copied');
    expect(memo.conflictOf).toBe(ID);
    expect(stored(memoKey(ID))).toBeUndefined();
  });

  it('rejects a save over a body this build cannot read, and writes nothing', async () => {
    getChromeFake().state.local.set(memoKey(ID), { schemaVersion: 9, id: ID });
    await expect(memoRepo.save({ id: ID, text: 'x', expected: [null] })).rejects.toThrow();
    expect(await memoRepo.get(ID)).toBe('unreadable');
  });
});

describe('memoRepo.remove and restore', () => {
  it('removes in one write and restores above the deletion', async () => {
    await memoRepo.save({ id: ID, text: 'a', expected: [null] }, 10);
    const writes = recordWrites();
    const removed = await memoRepo.remove(ID, 20);
    expect(removed?.text).toBe('a');
    expect(writes).toEqual([[MEMO_INDEX_KEY, memoKey(ID)].sort()]);
    expect(await memoRepo.get(ID)).toBeNull();
    expect(await memoRepo.listSummaries()).toEqual([]);

    const back = await memoRepo.restore(removed!, 15);
    expect(back.updatedAt).toBeGreaterThan(10);
    expect((await memoRepo.get(ID)) as Memo).toMatchObject({ text: 'a' });
  });

  it('restores into a copy when another text took the id meanwhile', async () => {
    await memoRepo.save({ id: ID, text: 'a', expected: [null] }, 10);
    const removed = (await memoRepo.remove(ID, 20))!;
    await memoRepo.save({ id: ID, text: 'other', expected: [null] }, 30);
    const back = await memoRepo.restore(removed, 40);
    expect(back.id).not.toBe(ID);
    expect(back.conflictOf).toBe(ID);
    expect(await memoRepo.listSummaries()).toHaveLength(2);
  });

  it('removing a memo that is gone is undefined', async () => {
    expect(await memoRepo.remove(ID)).toBeUndefined();
  });
});

describe('memoRepo.adoptDrafts', () => {
  const draft = (overrides: Partial<MemoDraft>): MemoDraft => ({
    schemaVersion: 1,
    id: ID,
    text: 'draft',
    bases: [null],
    at: 1,
    ...overrides,
  });

  it('saves a draft through the save rule and removes it in the same write', async () => {
    getChromeFake().state.local.set(memoDraftKey('e1'), draft({}));
    const writes = recordWrites();
    expect(await memoRepo.adoptDrafts(50)).toBe(1);
    expect(writes).toEqual([[MEMO_INDEX_KEY, memoDraftKey('e1'), memoKey(ID)].sort()]);
    expect(stored(memoDraftKey('e1'))).toBeUndefined();
    expect(((await memoRepo.get(ID)) as Memo).text).toBe('draft');
  });

  it('only removes a draft whose text the memo already has, or a blank never-saved one', async () => {
    await memoRepo.save({ id: ID, text: 'same', expected: [null] }, 10);
    getChromeFake().state.local.set(memoDraftKey('e1'), draft({ text: 'same', bases: ['x'] }));
    getChromeFake().state.local.set(
      memoDraftKey('e2'),
      draft({ id: 'blank-one', text: '  ', bases: [null] }),
    );
    expect(await memoRepo.adoptDrafts(50)).toBe(0);
    expect(stored(memoDraftKey('e1'))).toBeUndefined();
    expect(stored(memoDraftKey('e2'))).toBeUndefined();
    expect(await memoRepo.get('blank-one')).toBeNull();
  });

  it('copies a draft whose memo changed elsewhere, and leaves an unreadable draft', async () => {
    await memoRepo.save({ id: ID, text: 'theirs', expected: [null] }, 10);
    getChromeFake().state.local.set(memoDraftKey('e1'), draft({ text: 'mine', bases: ['old'] }));
    getChromeFake().state.local.set(memoDraftKey('e2'), { schemaVersion: 2 });
    expect(await memoRepo.adoptDrafts(50)).toBe(1);
    expect(await memoRepo.listSummaries()).toHaveLength(2);
    expect(stored(memoDraftKey('e2'))).toEqual({ schemaVersion: 2 });
  });

  it('parses drafts strictly', () => {
    expect(parseMemoDraft(draft({}))).toEqual(draft({}));
    expect(parseMemoDraft({ ...draft({}), bases: [1] })).toBeNull();
    expect(parseMemoDraft(null)).toBeNull();
  });
});

describe('memoRepo.reconcile', () => {
  it('removes null bodies, re-indexes orphans and keeps an unreadable body listed', async () => {
    await memoRepo.save({ id: ID, text: 'kept', expected: [null] }, 10);
    const fake = getChromeFake().state.local;
    fake.set(memoKey('gone'), null);
    fake.set(memoKey('orphan'), {
      schemaVersion: 1,
      id: 'orphan',
      text: 'found',
      createdAt: 1,
      updatedAt: 99,
    });
    fake.set(memoKey(ID), { schemaVersion: 7, id: ID });

    const result = await memoRepo.reconcile();
    expect(result.reindexed).toBe(1);
    expect(fake.has(memoKey('gone'))).toBe(false);
    expect((await memoRepo.listSummaries()).map((s) => s.id)).toEqual(['orphan', ID]);
    expect(stored(memoKey(ID))).toEqual({ schemaVersion: 7, id: ID });
  });

  it('rebuilds a broken index', async () => {
    getChromeFake().state.local.set(MEMO_INDEX_KEY, 'junk');
    await memoRepo.reconcile();
    expect(await memoRepo.listSummaries()).toEqual([]);
  });
});

describe('memoCollection', () => {
  it('parses exact keys only', () => {
    expect(memoCollection.parseLive({ id: 'a', text: 't', createdAt: 1 })).toEqual({
      id: 'a',
      text: 't',
      createdAt: 1,
    });
    expect(memoCollection.parseLive({ id: 'a', text: 't', createdAt: 1, extra: 1 })).toBeNull();
    expect(memoCollection.parseLive({ id: 'a b', text: 't', createdAt: 1 })).toBeNull();
    expect(memoCollection.parseDeleted({ id: 'a' })).toEqual({ id: 'a' });
    expect(memoCollection.parseDeleted({ id: 'a', text: '' })).toBeNull();
    expect(memoCollection.fingerprint({ id: 'a', text: 't', createdAt: 1 })).toEqual(['t']);
  });
});
