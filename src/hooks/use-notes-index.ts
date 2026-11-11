import { useEffect, useState } from 'react';

import { reportError } from '@/lib/error-message';
import { NOTES_INDEX_KEY, notesRepo } from '@/lib/notes-repo';
import type { NotesSummary } from '@/types';

interface NotesIndexState {
  /** The videos with notes, newest first. */
  notes: NotesSummary[];
  loading: boolean;
  /** Why the list could not be read, in the UI language. */
  error?: string;
}

/**
 * The videos with YouTube notes, read through `notesRepo` and read again whenever `notesIndex`
 * changes (a note written in the side panel, a deletion here). Whichever read started last wins.
 */
export function useNotesIndex(): NotesIndexState {
  const [state, setState] = useState<NotesIndexState>({ notes: [], loading: true });

  useEffect(() => {
    let generation = 0;
    let live = true;
    const load = () => {
      const mine = ++generation;
      notesRepo.listSummaries().then(
        (notes) => {
          if (live && mine === generation) {
            setState({ notes, loading: false });
          }
        },
        (err: unknown) => {
          if (live && mine === generation) {
            setState((previous) => ({
              notes: previous.notes,
              loading: false,
              error: reportError('notes index', err),
            }));
          }
        },
      );
    };
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && Object.hasOwn(changes, NOTES_INDEX_KEY)) {
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
