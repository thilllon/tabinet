import { useEffect, useState } from 'react';

import { reportError } from '@/lib/error-message';
import { memoKey, memoRepo } from '@/lib/memo-repo';
import type { Memo } from '@/types';

/** A memo's stored body, with the id it was read for (a view that follows a copy changes id). */
export type MemoBodyState =
  | { state: 'loading'; id: string }
  | { state: 'none'; id: string }
  | { state: 'unreadable'; id: string }
  | { state: 'live'; id: string; memo: Memo };

/** One memo's stored body, read again whenever its key changes (a save here or elsewhere, sync). */
export function useMemoBody(id: string): MemoBodyState {
  const [state, setState] = useState<MemoBodyState>({ state: 'loading', id });

  useEffect(() => {
    let generation = 0;
    let live = true;
    const load = () => {
      const mine = ++generation;
      memoRepo.get(id).then(
        (memo) => {
          if (live && mine === generation) {
            setState(
              memo === null
                ? { state: 'none', id }
                : memo === 'unreadable'
                  ? { state: 'unreadable', id }
                  : { state: 'live', id, memo },
            );
          }
        },
        (err: unknown) => {
          reportError('memo body', err);
          if (live && mine === generation) {
            setState({ state: 'unreadable', id });
          }
        },
      );
    };
    const key = memoKey(id);
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && Object.hasOwn(changes, key)) {
        load();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    load();
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [id]);

  return state.id === id ? state : { state: 'loading', id };
}
