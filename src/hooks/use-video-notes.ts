import { useEffect, useState } from 'react';

import { reportError } from '@/lib/error-message';
import { notesKey, notesRepo } from '@/lib/notes-repo';
import type { VideoNotes } from '@/types';

export interface VideoNotesState {
  /** `undefined` while loading, `null` when the video has no notes yet. */
  notes: VideoNotes | null | undefined;
  /** Why the notes could not be read, in the UI language. */
  error: string | undefined;
}

/**
 * One video's notes, read through `notesRepo` and read again whenever its `notes:<videoId>` key
 * changes (a save here, or in the panel of another window).
 */
export function useVideoNotes(videoId: string | undefined): VideoNotesState {
  const [state, setState] = useState<VideoNotesState>({ notes: undefined, error: undefined });

  useEffect(() => {
    setState({ notes: undefined, error: undefined });
    if (videoId === undefined) {
      return;
    }
    let live = true;
    const key = notesKey(videoId);
    const load = () => {
      notesRepo.get(videoId).then(
        (notes) => {
          if (live) {
            setState({ notes: notes ?? null, error: undefined });
          }
        },
        (err: unknown) => {
          if (live) {
            setState({ notes: null, error: reportError('notes', err) });
          }
        },
      );
    };
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: chrome.storage.AreaName,
    ) => {
      if (areaName === 'local' && key in changes) {
        load();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    load();
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [videoId]);

  return state;
}
