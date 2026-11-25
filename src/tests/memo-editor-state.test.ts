import { describe, expect, it, vi } from 'vitest';

import {
  draftOf,
  flushMemoEditors,
  followedSlot,
  MemoEditorSession,
  type MemoSaver,
  memoEditorFor,
  registerMemoEditor,
  remoteAction,
} from '@/lib/memo-editor-state';
import { memoRepo } from '@/lib/memo-repo';
import type { Memo } from '@/types';

const memo = (id: string, text: string): Memo => ({
  schemaVersion: 1,
  id,
  text,
  createdAt: 1,
  updatedAt: 2,
});

describe('MemoEditorSession', () => {
  it('never stores a blank new memo, and skips a text already saved', async () => {
    const saver = vi.fn<MemoSaver>();
    const session = new MemoEditorSession('m', null, saver);
    expect(await session.save(() => '   ')).toBeUndefined();
    expect(saver).not.toHaveBeenCalled();
    session.adopt('kept');
    expect(await session.save(() => 'kept')).toBeUndefined();
  });

  it('passes the last confirmed text as the precondition, and then the new one', async () => {
    const saver = vi.fn<MemoSaver>(async ({ id, text }) => ({
      outcome: 'saved',
      memo: memo(id, text),
    }));
    const session = new MemoEditorSession('m', null, saver);
    await session.save(() => 'a');
    await session.save(() => 'ab');
    expect(saver.mock.calls.map(([input]) => input.expected)).toEqual([[null], ['a']]);
    expect(session.saved).toBe('ab');
  });

  it('keeps a failed save expected by the next one, and in the draft', async () => {
    let fail = true;
    const saver = vi.fn<MemoSaver>(async ({ id, text }) => {
      if (fail) {
        throw new Error('quota');
      }
      return { outcome: 'saved', memo: memo(id, text) };
    });
    const session = new MemoEditorSession('m', 'a', saver);
    await expect(session.save(() => 'ab')).rejects.toThrow('quota');
    expect(session.draft('abc', 9)).toEqual({
      schemaVersion: 1,
      id: 'm',
      text: 'abc',
      bases: ['a', 'ab'],
      at: 9,
    });
    fail = false;
    await session.save(() => 'abc');
    expect(saver.mock.calls[1]?.[0].expected).toEqual(['a', 'ab']);
  });

  it('runs saves one after the other, each reading the box at its turn', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const saver: MemoSaver = async ({ id, text }) => {
      seen.push(text);
      if (seen.length === 1) {
        await gate;
      }
      return { outcome: 'saved', memo: memo(id, text) };
    };
    const session = new MemoEditorSession('m', null, saver);
    let box = 'one';
    const first = session.save(() => box);
    await vi.waitFor(() => expect(seen).toEqual(['one']));
    box = 'two';
    const second = session.save(() => box);
    expect(seen).toEqual(['one']);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(['one', 'two']);
  });

  it('follows the memo a save wrote to', async () => {
    const session = new MemoEditorSession('m', 'a', async ({ text }) => ({
      outcome: 'copied',
      memo: memo('copy', text),
    }));
    const done = await session.save(() => 'b');
    expect(done?.followed).toBe(true);
    expect(session.memoId).toBe('copy');
  });

  it('works with the real repository end to end', async () => {
    const session = new MemoEditorSession('real', null);
    await session.save(() => 'hello');
    expect(((await memoRepo.get('real')) as Memo).text).toBe('hello');
  });
});

describe('draftOf', () => {
  it('is null for a clean box and for a blank memo never saved', () => {
    expect(draftOf('m', 'a', 'a', [], 1)).toBeNull();
    expect(draftOf('m', ' ', null, [], 1)).toBeNull();
    expect(draftOf('m', 'x', null, [], 1)?.bases).toEqual([null]);
  });
});

describe('remoteAction', () => {
  it.each<[string | null, string, string | null, string]>([
    ['same', 'same', 'same', 'none'],
    ['theirs', 'mine', 'mine', 'take'],
    [null, 'mine', 'mine', 'leave'],
    ['theirs', 'edited', 'mine', 'keep'],
    [null, 'edited', 'mine', 'keep'],
    ['edited', 'edited', 'mine', 'take'],
  ])('stored %j, box %j, saved %j: %s', (stored, box, saved, action) => {
    expect(remoteAction(stored, box, saved)).toBe(action);
  });
});

describe('memoEditorFor', () => {
  let n = 0;
  const make = () => `id${++n}`;

  it('keeps the editor while the route is its own, also after it followed a copy', () => {
    const fresh = memoEditorFor(null, undefined, make);
    expect(fresh.isNew).toBe(true);
    expect(memoEditorFor(fresh, undefined, make)).toBe(fresh);
    const followed = followedSlot(fresh, 'saved-id');
    expect(memoEditorFor(followed, 'saved-id', make)).toBe(followed);
    expect(followed.editorId).toBe(fresh.editorId);
  });

  it('makes a new editor for another memo, or for New memo after a save', () => {
    const open = memoEditorFor(null, 'a', make);
    expect(open).toMatchObject({ memoId: 'a', routeId: 'a', isNew: false });
    expect(memoEditorFor(open, 'b', make).editorId).not.toBe(open.editorId);
    expect(memoEditorFor(open, undefined, make).isNew).toBe(true);
  });
});

describe('flushMemoEditors', () => {
  it('waits for every open editor and never rejects', async () => {
    const order: string[] = [];
    const stopA = registerMemoEditor(async () => {
      order.push('a');
    });
    const stopB = registerMemoEditor(async () => {
      throw new Error('failed');
    });
    await expect(flushMemoEditors()).resolves.toBeUndefined();
    expect(order).toEqual(['a']);
    stopA();
    stopB();
    await flushMemoEditors();
    expect(order).toEqual(['a']);
  });
});
