import { useEffect, useRef, useState } from 'react';

import { errorDetail } from '@/lib/error-message';
import { notesRepo } from '@/lib/notes-repo';
import { notesToLoad, scheduleIdle } from '@/lib/search-corpus';
import { entriesFromNotes, type SearchEntry } from '@/lib/search-engine';
import type { NotesSummary } from '@/types';

interface LoadedNotes {
  updatedAt: number;
  entries: SearchEntry[];
}

/**
 * The search entries of every YouTube note (`entriesFromNotes`), read through `notesRepo` on idle
 * and again for a video only when its `updatedAt` in the index changes. Notes bodies hold text
 * only (screenshots are stored apart), so all of them are read, with no budget.
 */
export function useNotesSearchEntries(summaries: readonly NotesSummary[]): SearchEntry[] {
  const loaded = useRef(new Map<string, LoadedNotes>());
  const [entries, setEntries] = useState<SearchEntry[]>([]);

  useEffect(() => {
    const cache = loaded.current;
    const live = new Set(summaries.map((summary) => summary.videoId));
    let dropped = false;
    for (const videoId of cache.keys()) {
      if (!live.has(videoId)) {
        cache.delete(videoId);
        dropped = true;
      }
    }
    const publish = () =>
      setEntries(summaries.flatMap((summary) => cache.get(summary.videoId)?.entries ?? []));
    const loadedAt = new Map([...cache].map(([videoId, notes]) => [videoId, notes.updatedAt]));
    const pending = notesToLoad(summaries, loadedAt);
    if (pending.length === 0) {
      if (dropped) {
        publish();
      }
      return;
    }
    let disposed = false;
    const cancel = scheduleIdle(() => {
      void (async () => {
        for (const videoId of pending) {
          try {
            const notes = await notesRepo.get(videoId);
            if (disposed) {
              return;
            }
            cache.set(videoId, {
              updatedAt: summaries.find((summary) => summary.videoId === videoId)?.updatedAt ?? 0,
              entries: notes === undefined ? [] : entriesFromNotes(notes),
            });
          } catch (err) {
            // A body from a newer version: listed, not searchable.
            console.warn('[tabinet:notes] search corpus load failed', videoId, errorDetail(err));
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
