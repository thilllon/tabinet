import { useEffect, useState } from 'react';

import { reportError } from '@/lib/error-message';
import { MEMO_INDEX_KEY, memoRepo } from '@/lib/memo-repo';
import type { MemoSummary } from '@/types';

interface MemoIndexState {
  /** Every memo, newest first. */
  memos: MemoSummary[];
  loading: boolean;
  /** Why the list could not be read, in the UI language. */
  error?: string;
}

/**
 * The memos, read through `memoRepo` and read again whenever `memoIndex` changes (a save here, in
 * another tab, or one sync applied). Whichever read started last wins.
 */
export function useMemoIndex(): MemoIndexState {
  const [state, setState] = useState<MemoIndexState>({ memos: [], loading: true });

  useEffect(() => {
    let generation = 0;
    let live = true;
    const load = () => {
      const mine = ++generation;
      memoRepo.listSummaries().then(
        (memos) => {
          if (live && mine === generation) {
            setState({ memos, loading: false });
          }
        },
        (err: unknown) => {
          if (live && mine === generation) {
            setState((previous) => ({
              memos: previous.memos,
              loading: false,
              error: reportError('memo index', err),
            }));
          }
        },
      );
    };
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && Object.hasOwn(changes, MEMO_INDEX_KEY)) {
        load();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    load();
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return state;
}
