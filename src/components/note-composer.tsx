import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { isSubmitShortcut } from '@/lib/ime-composition';
import { shortcutText } from '@/lib/keyboard-shortcuts';
import { cn } from '@/lib/utils';

interface NoteComposerProps {
  /** What the text box is called for a screen reader, e.g. "Note at 1:23". */
  label: string;
  /** The text being edited; empty for a new note. */
  defaultValue?: string;
  /** Saving no text is fine: the note has a screenshot. */
  allowEmpty?: boolean;
  isMac: boolean;
  saving: boolean;
  onSave(text: string): void;
  onCancel(): void;
}

/**
 * A note's text box with Save and Cancel. Uncontrolled: typing redraws nothing, the text is read
 * when it is saved. Ctrl+Enter (Command+Enter on a Mac) saves, Escape cancels. An empty note is
 * refused on save (unless `allowEmpty`), and the message goes as soon as the person types again.
 */
export function NoteComposer({
  label,
  defaultValue = '',
  allowEmpty = false,
  isMac,
  saving,
  onSave,
  onCancel,
}: NoteComposerProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  const emptyId = useId();
  const [empty, setEmpty] = useState(false);

  const submit = () => {
    const text = box.current?.value ?? '';
    if (!allowEmpty && text.trim() === '') {
      setEmpty(true);
      box.current?.focus();
      return;
    }
    onSave(text);
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={box}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the box opens because the person just asked to write a note.
        autoFocus
        defaultValue={defaultValue}
        aria-label={label}
        aria-invalid={empty || undefined}
        aria-describedby={empty ? emptyId : undefined}
        placeholder={t('notesPlaceholder', shortcutText('Ctrl+Enter', isMac))}
        rows={4}
        disabled={saving}
        className={cn(
          'min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none placeholder:text-muted-foreground dark:bg-input/30',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        )}
        onInput={() => setEmpty(false)}
        onKeyDown={(event) => {
          if (isSubmitShortcut(event)) {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {empty && (
        <p id={emptyId} className="text-xs text-destructive">
          {t('notesEmptyText')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t('commonCancel')}
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {t('commonSave')}
        </Button>
      </div>
    </form>
  );
}
