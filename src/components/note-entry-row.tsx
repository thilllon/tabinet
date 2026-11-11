import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { NoteComposer } from '@/components/note-composer';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { formatTimestamp } from '@/lib/youtube-video';
import type { NoteEntry } from '@/types';

interface NoteEntryRowProps {
  entry: NoteEntry;
  /** The time can seek: the panel has access to YouTube. */
  canSeek: boolean;
  isMac: boolean;
  onSeek(at: number): void;
  /** Saves new text; resolves `true` once it is stored. */
  onEdit(entry: NoteEntry, text: string): Promise<boolean>;
  onDelete(entry: NoteEntry): void;
}

/**
 * One note: its time (a button that jumps the video there), its text as written (Markdown is not
 * rendered, only kept), and Edit and Delete. Editing swaps the text for the same box a new note
 * is written in.
 */
export function NoteEntryRow({
  entry,
  canSeek,
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
      {editing ? (
        <NoteComposer
          label={t('notesEntryLabel', time)}
          defaultValue={entry.text}
          isMac={isMac}
          saving={saving}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <pre className="font-sans text-sm break-words whitespace-pre-wrap">{entry.text}</pre>
      )}
    </li>
  );
}
