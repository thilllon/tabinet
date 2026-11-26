import { describe, expect, it, vi } from 'vitest';

import { memoDraftKey, memoKey } from '@/lib/memo-repo';
import type { Memo, MemoDraft } from '@/types';

import { fetchPackagedFile, getChromeFake } from './chrome-fake';

/** Memo drafts in the worker (spec 12.1): adopted on a new draft, on startup and on install. */

const ID = 'memo-1';
const draft: MemoDraft = { schemaVersion: 1, id: ID, text: 'left behind', bases: [null], at: 1 };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loadWorker(): Promise<void> {
  vi.stubGlobal('fetch', fetchPackagedFile);
  vi.resetModules();
  await import('@/service-worker');
}

describe('memo drafts in the worker', () => {
  it('adopts a draft written while it runs, and removes it', async () => {
    await loadWorker();
    await chrome.storage.local.set({ [memoDraftKey('editor')]: draft });
    await settle();
    const local = getChromeFake().state.local;
    expect((local.get(memoKey(ID)) as Memo | undefined)?.text).toBe('left behind');
    expect(local.has(memoDraftKey('editor'))).toBe(false);
  });

  it('adopts drafts on startup and on install', async () => {
    const local = getChromeFake().state.local;
    local.set(memoDraftKey('a'), draft);
    await loadWorker();
    getChromeFake().fire.startup();
    await settle();
    expect((local.get(memoKey(ID)) as Memo | undefined)?.text).toBe('left behind');

    local.set(memoDraftKey('b'), { ...draft, id: 'memo-2', text: 'second' });
    getChromeFake().fire.installed({ reason: 'update', previousVersion: '9.1.0' });
    await settle();
    expect((local.get(memoKey('memo-2')) as Memo | undefined)?.text).toBe('second');
  });
});
