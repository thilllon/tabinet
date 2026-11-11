import { Ellipsis, ExternalLink, FileText, Trash2 } from 'lucide-react';
import { useCallback, useContext, useState } from 'react';

import { DeleteVideoNotesDialog } from '@/components/delete-video-notes-dialog';
import { NoteEntryRow } from '@/components/note-entry-row';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToastContext, useErrorToast } from '@/hooks/use-toasts';
import { useVideoNotes } from '@/hooks/use-video-notes';
import { formatDateTime } from '@/lib/display-format';
import { downloadExport } from '@/lib/download-and-copy';
import { reportError } from '@/lib/error-message';
import { exportedNotice } from '@/lib/export-actions';
import { joinFacts, t, tp } from '@/lib/i18n';
import { isMacPlatform } from '@/lib/keyboard-shortcuts';
import { notesToMarkdown, readNoteImages, videoTitle } from '@/lib/notes-export';
import { notesRepo } from '@/lib/notes-repo';
import { browserHandlesClick } from '@/lib/row-link';
import { ACTION_MS } from '@/lib/toast-queue';
import { openVideoAt } from '@/lib/window-actions';
import { canonicalVideoUrl, entriesByTime } from '@/lib/youtube-video';
import type { NoteEntry, NotesSummary } from '@/types';

const IS_MAC = isMacPlatform(navigator.userAgent);

interface NotesPageProps {
  summary: NotesSummary;
  onNotice(message: string): void;
  /** Every note on the video is gone; the view should leave. */
  onDeleted(): void;
}

/**
 * One video's YouTube notes on the app page: the notes in video order, each time a link to the
 * video at that second, with Edit and Delete as in the side panel (notes are written there, while
 * watching). Export Markdown saves them as one file; Delete all asks first.
 */
export function NotesPage({ summary, onNotice, onDeleted }: NotesPageProps) {
  const { videoId } = summary;
  const { notes, error: loadError } = useVideoNotes(videoId);
  const show = useContext(ToastContext);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useErrorToast(loadError);
  useErrorToast(error);

  const fail = useCallback((err: unknown) => setError(reportError('notes', err)), []);
  const title = videoTitle(notes ?? summary);

  const openAt = useCallback(
    (at?: number) => {
      setError(undefined);
      void openVideoAt(videoId, at).then((result) => {
        if (!result.ok) {
          setError(result.reason);
        } else if (result.switched) {
          onNotice(t('notesSwitchedToVideo'));
        }
      });
    },
    [videoId, onNotice],
  );

  const edit = useCallback(
    async (entry: NoteEntry, text: string): Promise<boolean> => {
      setError(undefined);
      try {
        return await notesRepo.updateEntry(videoId, entry.id, { text });
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [videoId, fail],
  );

  const remove = useCallback(
    (entry: NoteEntry) => {
      setError(undefined);
      const owner = { videoId, title: notes?.title ?? summary.title };
      notesRepo.removeEntry(videoId, entry.id).then((removed) => {
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
    [videoId, notes?.title, summary.title, show, fail],
  );

  const exportMarkdown = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const current = notes ?? (await notesRepo.get(videoId));
      if (!current) {
        return;
      }
      const text = notesToMarkdown(current, await readNoteImages(current));
      downloadExport(current.title, 'markdown', text);
      onNotice(exportedNotice(videoTitle(current), 'markdown'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    setConfirmingDelete(false);
    setBusy(true);
    setError(undefined);
    try {
      await notesRepo.remove(videoId);
      onNotice(t('notesDeletedAll', title));
      onDeleted();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const entries = notes ? entriesByTime(notes.entries) : [];
  const count = notes ? notes.entries.length : summary.entryCount;

  return (
    <section aria-label={title} className="min-w-0">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="line-clamp-2 text-lg font-semibold break-words" title={title}>
            {title}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {joinFacts([
              tp('notesEntryCount', count),
              t('notesUpdatedAt', formatDateTime(notes?.updatedAt ?? summary.updatedAt)),
            ])}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" title={t('notesOpenVideoTitle')}>
            <a
              href={canonicalVideoUrl(videoId)}
              onClick={(event) => {
                if (browserHandlesClick(event)) {
                  return;
                }
                event.preventDefault();
                openAt();
              }}
            >
              <ExternalLink />
              {t('notesOpenVideo')}
            </a>
          </Button>
          <Button
            variant="outline"
            disabled={busy || count === 0}
            title={t('notesExportMarkdownTitle')}
            onClick={() => void exportMarkdown()}
          >
            <FileText />
            {t('notesExportMarkdown')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('sessionMoreActions')}
                title={t('sessionMoreActions')}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onSelect={() => setConfirmingDelete(true)}
              >
                <Trash2 />
                {t('notesDeleteAll')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <p className="mt-3 text-xs text-muted-foreground">{t('notesPageHint')}</p>

      <div className="mt-4 rounded-lg border bg-card px-3">
        {notes === undefined ? (
          <p className="py-3 text-sm text-muted-foreground">{t('commonLoading')}</p>
        ) : entries.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{t('notesEmpty')}</p>
        ) : (
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <NoteEntryRow
                key={entry.id}
                entry={entry}
                canSeek
                linkToVideoId={videoId}
                isMac={IS_MAC}
                onSeek={openAt}
                onEdit={edit}
                onDelete={remove}
              />
            ))}
          </ul>
        )}
      </div>

      <DeleteVideoNotesDialog
        title={title}
        count={count}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onConfirm={() => void deleteAll()}
      />
    </section>
  );
}
