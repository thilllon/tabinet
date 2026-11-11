import { useCallback, useRef, useState } from 'react';

import { AddNoteBar } from '@/components/add-note-bar';
import { NoteComposer } from '@/components/note-composer';
import { NoteEntryRow } from '@/components/note-entry-row';
import { NotesAccessField } from '@/components/notes-access-field';
import { SavedToasts } from '@/components/saved-toasts';
import { useActiveVideo } from '@/hooks/use-active-video';
import { ToastContext, useErrorToast, useSavedToasts } from '@/hooks/use-toasts';
import { useVideoNotes } from '@/hooks/use-video-notes';
import { useYoutubeAccess } from '@/hooks/use-youtube-access';
import { reportError } from '@/lib/error-message';
import { type MessageKey, t } from '@/lib/i18n';
import { isMacPlatform } from '@/lib/keyboard-shortcuts';
import { notesRepo } from '@/lib/notes-repo';
import { ACTION_MS, ERROR_MS } from '@/lib/toast-queue';
import { readNotesPause, writeNotesPause } from '@/lib/ui-state';
import {
  captureFrame,
  type FrameFailure,
  pausePlayer,
  playPlayer,
  readPlayer,
  seekPlayer,
} from '@/lib/youtube-player';
import {
  type ActiveVideo,
  cleanVideoTitle,
  entriesByTime,
  formatTimestamp,
} from '@/lib/youtube-video';
import type { NoteEntry } from '@/types';

const IS_MAC = isMacPlatform(navigator.userAgent);

/** The toast for each reason a screenshot could not be taken. */
const FRAME_FAILURE_KEYS = {
  noVideo: 'notesScreenshotNoVideo',
  notReady: 'notesScreenshotNotReady',
  blocked: 'notesScreenshotBlocked',
  failed: 'notesScreenshotFailed',
} as const satisfies Record<FrameFailure, MessageKey>;

/** A note being written: where in the video, and whether the panel paused the video for it. */
interface Draft {
  /** Tells one draft from the next, so a new one starts with an empty box. */
  key: number;
  videoId: string;
  at: number;
  /** The title the page showed when the note was started. */
  title: string;
  pausedForIt: boolean;
}

/**
 * The YouTube notes side panel: notes on the video in the active tab of this window, with the
 * time each was taken. "Add note at" reads the time from the page (and pauses the video while the
 * note is written, if the box says so); a note's time jumps the video back there. Without access
 * to YouTube nothing can be read, so the switch to allow it is shown instead.
 */
export function NotesPanel() {
  const { video } = useActiveVideo();
  const granted = useYoutubeAccess();
  const { notes, error: loadError } = useVideoNotes(video?.videoId);
  const { toasts, show, dismiss } = useSavedToasts();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pauseWhileWriting, setPauseWhileWriting] = useState(readNotesPause);
  // The tab the draft's video plays in, to resume it; the active tab may change meanwhile.
  const draftTab = useRef<number | undefined>(undefined);
  const draftCount = useRef(0);

  useErrorToast(loadError, show);

  // Every failure is a red toast; shown directly, so the same failure twice shows twice.
  const showError = useCallback(
    (message: string) => show(message, { ms: ERROR_MS, tone: 'error' }),
    [show],
  );

  const fail = useCallback((err: unknown) => showError(reportError('notes', err)), [showError]);

  const playerFailed = useCallback(
    (err: unknown) => {
      console.error('[tabinet:notes] player not reached', err);
      showError(t('notesPlayerFailed'));
    },
    [showError],
  );

  const resumeIfPaused = (current: Draft) => {
    const tabId = draftTab.current;
    if (current.pausedForIt && tabId !== undefined) {
      playPlayer(tabId).catch(playerFailed);
    }
  };

  const startNote = (active: ActiveVideo) => {
    setBusy(true);
    const ask = pauseWhileWriting ? pausePlayer(active.tabId) : readPlayer(active.tabId);
    ask
      .then((player) => {
        if (player === null) {
          showError(t('notesPlayerFailed'));
          return;
        }
        draftTab.current = active.tabId;
        draftCount.current += 1;
        setDraft({
          key: draftCount.current,
          videoId: active.videoId,
          at: player.currentTime,
          title: cleanVideoTitle(player.title) || active.title,
          pausedForIt: player.changed,
        });
      }, playerFailed)
      .finally(() => setBusy(false));
  };

  const saveDraft = (current: Draft, text: string) => {
    setBusy(true);
    notesRepo
      .addEntry({ videoId: current.videoId, title: current.title }, { at: current.at, text })
      .then(() => {
        setDraft(null);
        resumeIfPaused(current);
      }, fail)
      .finally(() => setBusy(false));
  };

  // A note holding the frame on screen, at the time it was taken; text can be added with Edit.
  const takeScreenshot = (active: ActiveVideo) => {
    setBusy(true);
    captureFrame(active.tabId)
      .then(async (frame) => {
        if (!frame.ok) {
          showError(t(FRAME_FAILURE_KEYS[frame.reason]));
          return;
        }
        const entry = await notesRepo.addEntry(
          { videoId: active.videoId, title: cleanVideoTitle(frame.title) || active.title },
          { at: frame.currentTime, text: '', image: frame.dataUrl },
        );
        show(t('notesScreenshotAdded', formatTimestamp(entry.at)));
      }, playerFailed)
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const cancelDraft = (current: Draft) => {
    setDraft(null);
    resumeIfPaused(current);
  };

  const seek = useCallback(
    (at: number) => {
      if (video) {
        seekPlayer(video.tabId, at).catch(playerFailed);
      }
    },
    [video, playerFailed],
  );

  const edit = useCallback(
    async (entry: NoteEntry, text: string): Promise<boolean> => {
      if (!video) {
        return false;
      }
      try {
        return await notesRepo.updateEntry(video.videoId, entry.id, { text });
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [video, fail],
  );

  const remove = useCallback(
    (entry: NoteEntry) => {
      if (!video) {
        return;
      }
      const owner = { videoId: video.videoId, title: notes?.title ?? video.title };
      notesRepo.removeEntry(video.videoId, entry.id).then((removed) => {
        if (removed === undefined) {
          return;
        }
        show(t('notesDeleted'), {
          plain: true,
          ms: ACTION_MS,
          action: {
            label: t('notesUndo'),
            run: () => {
              notesRepo.restoreEntry(owner, removed).catch(fail);
            },
          },
        });
      }, fail);
    },
    [video, notes?.title, show, fail],
  );

  const choosePause = (on: boolean) => {
    setPauseWhileWriting(on);
    writeNotesPause(on);
  };

  const entries = notes ? entriesByTime(notes.entries) : [];
  const title = notes?.title || video?.title || '';

  return (
    <ToastContext.Provider value={show}>
      <main className="flex min-h-screen flex-col gap-3 p-3 text-sm">
        <header>
          <p className="text-xs font-medium text-muted-foreground">{t('cmdOpenNotes')}</p>
          {video && title !== '' && (
            <h1 className="mt-0.5 line-clamp-3 text-base font-semibold" title={title}>
              {title}
            </h1>
          )}
        </header>

        {/* Kept mounted while another tab is in front, so a note half written survives a look at
            another tab; it shows again with its video. */}
        {draft !== null && (
          <section
            key={draft.key}
            className="flex flex-col gap-1"
            hidden={draft.videoId !== video?.videoId}
          >
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatTimestamp(draft.at)}
            </p>
            <NoteComposer
              label={t('notesEntryLabel', formatTimestamp(draft.at))}
              isMac={IS_MAC}
              saving={busy}
              onSave={(text) => saveDraft(draft, text)}
              onCancel={() => cancelDraft(draft)}
            />
          </section>
        )}

        {video === undefined ? (
          <p className="text-muted-foreground">{t('commonLoading')}</p>
        ) : video === null ? (
          <p className="text-muted-foreground">{t('notesNotVideo')}</p>
        ) : (
          <>
            {granted !== true && (
              <NotesAccessField
                granted={granted}
                onDeclined={() => show(t('notesAccessDeclined'), { plain: true })}
                onError={fail}
              />
            )}
            {(draft === null || draft.videoId !== video.videoId) && (
              <AddNoteBar
                tabId={video.tabId}
                enabled={granted === true}
                busy={busy}
                pauseWhileWriting={pauseWhileWriting}
                onPauseWhileWritingChange={choosePause}
                onAdd={() => startNote(video)}
                onScreenshot={() => takeScreenshot(video)}
              />
            )}
            {notes === undefined ? (
              <p className="text-muted-foreground">{t('commonLoading')}</p>
            ) : entries.length === 0 ? (
              <p className="text-muted-foreground">{t('notesEmpty')}</p>
            ) : (
              <ul className="flex flex-col">
                {entries.map((entry) => (
                  <NoteEntryRow
                    key={entry.id}
                    entry={entry}
                    canSeek={granted === true}
                    isMac={IS_MAC}
                    onSeek={seek}
                    onEdit={edit}
                    onDelete={remove}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </main>
      <SavedToasts toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
