import { Pencil, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';

import { NoteComposer } from '@/components/note-composer';
import { NoteThumbnail } from '@/components/note-thumbnail';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { browserHandlesClick } from '@/lib/row-link';
import { formatTimestamp, videoUrlAt } from '@/lib/youtube-video';
import type { NoteEntry } from '@/types';

interface NoteEntryRowProps {
  entry: NoteEntry;
  /** The time can seek: the panel has access to YouTube. */
  canSeek: boolean;
  /**
   * The app page: the time is a link to the video at that second (`onSeek` opens it), rather
   * than a button that moves the video playing beside the panel.
   */
  linkToVideoId?: string;
  isMac: boolean;
  onSeek(at: number): void;
  /** Saves new text; resolves `true` once it is stored. */
  onEdit(entry: NoteEntry, text: string): Promise<boolean>;
  onDelete(entry: NoteEntry): void;
}

/**
 * One note: its time (a button that jumps the video there), its screenshot if it has one (a
 * click enlarges it), its text as written (Markdown is not rendered, only kept), and Edit and
 * Delete. A note with a screenshot may have no text. Editing swaps the text for the same box a new
 * note is written in. Memoized: the panel redraws on every toast and save, and the list stays as
 * it is.
 */
export const NoteEntryRow = memo(function NoteEntryRow({
  entry,
  canSeek,
  linkToVideoId,
  isMac,
  onSeek,
  onEdit,
  onDelete,
}: NoteEntryRowProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const time = formatTimestamp(entry.at);

  const save = (text: string) => {
    setSaving(true);
    onEdit(entry, text)
      .then((ok) => {
        if (ok) {
          setEditing(false);
        }
      })
      .finally(() => setSaving(false));
  };

  return (
    <li className="group flex flex-col gap-1 border-b py-2 last:border-b-0">
      <div className="flex items-center gap-1">
        {linkToVideoId === undefined ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 font-mono tabular-nums"
            disabled={!canSeek}
            title={t('notesJumpTo', time)}
            onClick={() => onSeek(entry.at)}
          >
            {time}
          </Button>
        ) : (
          <Button asChild variant="link" size="sm" className="h-auto px-0 font-mono tabular-nums">
            <a
              href={videoUrlAt(linkToVideoId, entry.at)}
              title={t('notesOpenAt', time)}
              onClick={(event) => {
                if (browserHandlesClick(event)) {
                  return;
                }
                event.preventDefault();
                onSeek(entry.at);
              }}
            >
              {time}
            </a>
          </Button>
        )}
        <span className="flex-1" />
        {!editing && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('notesEditEntry', time)}
              title={t('notesEditEntry', time)}
              onClick={() => setEditing(true)}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('notesDeleteEntry', time)}
              title={t('notesDeleteEntry', time)}
              onClick={() => onDelete(entry)}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {entry.imageId !== undefined && <NoteThumbnail imageId={entry.imageId} time={time} />}
      {editing ? (
        <NoteComposer
          label={t('notesEntryLabel', time)}
          defaultValue={entry.text}
          allowEmpty={entry.imageId !== undefined}
          isMac={isMac}
          saving={saving}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        entry.text.trim() !== '' && (
          <pre className="font-sans text-sm break-words whitespace-pre-wrap">{entry.text}</pre>
        )
      )}
    </li>
  );
});
