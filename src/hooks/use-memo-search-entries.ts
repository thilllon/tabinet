import { useEffect, useRef, useState } from 'react';

import { errorDetail } from '@/lib/error-message';
import { memoRepo } from '@/lib/memo-repo';
import { memosToLoad, scheduleIdle } from '@/lib/search-corpus';
import { entryFromMemo, type SearchEntry } from '@/lib/search-engine';
import type { MemoSummary } from '@/types';

interface LoadedMemo {
  updatedAt: number;
  entry: SearchEntry | undefined;
}

/**
 * The search entry of every memo (`entryFromMemo`), always searched: read through `memoRepo` on
 * idle, and again for a memo only when its `updatedAt` in the index changes.
 */
export function useMemoSearchEntries(summaries: readonly MemoSummary[]): SearchEntry[] {
  const loaded = useRef(new Map<string, LoadedMemo>());
  const [entries, setEntries] = useState<SearchEntry[]>([]);

  useEffect(() => {
    const cache = loaded.current;
    const live = new Set(summaries.map((summary) => summary.id));
    let dropped = false;
    for (const id of cache.keys()) {
      if (!live.has(id)) {
        cache.delete(id);
        dropped = true;
      }
    }
    const publish = () =>
      setEntries(
        summaries.flatMap((summary) => {
          const entry = cache.get(summary.id)?.entry;
          return entry === undefined ? [] : [entry];
        }),
      );
    const loadedAt = new Map([...cache].map(([id, memo]) => [id, memo.updatedAt]));
    const pending = memosToLoad(summaries, loadedAt);
    if (pending.length === 0) {
      if (dropped) {
        publish();
      }
      return;
    }
    let disposed = false;
    const cancel = scheduleIdle(() => {
      void (async () => {
        for (const id of pending) {
          try {
            const memo = await memoRepo.get(id);
            if (disposed) {
              return;
            }
            const summary = summaries.find((candidate) => candidate.id === id);
            cache.set(id, {
              updatedAt: summary?.updatedAt ?? 0,
              entry:
                memo === null || memo === 'unreadable' || summary === undefined
                  ? undefined
                  : entryFromMemo(memo, summary.title),
            });
          } catch (err) {
            console.warn('[tabinet:memos] search corpus load failed', id, errorDetail(err));
          }
        }
        if (!disposed) {
          publish();
        }
      })();
    });
    return () => {
      disposed = true;
      cancel();
    };
  }, [summaries]);

  return entries;
}
