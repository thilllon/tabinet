import { NotebookPen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { usePlayerTime } from '@/hooks/use-player-time';
import { t } from '@/lib/i18n';
import { formatTimestamp } from '@/lib/youtube-video';

interface AddNoteBarProps {
  tabId: number;
  /** The panel has access to YouTube, so the time can be read. */
  enabled: boolean;
  busy: boolean;
  pauseWhileWriting: boolean;
  onPauseWhileWritingChange(on: boolean): void;
  onAdd(): void;
}

/**
 * "Add note at 1:23", with the time following the video, and the "Pause while I write" box. The
 * time is read every second by this component alone, so the notes under it are not redrawn.
 */
export function AddNoteBar({
  tabId,
  enabled,
  busy,
  pauseWhileWriting,
  onPauseWhileWritingChange,
  onAdd,
}: AddNoteBarProps) {
  const player = usePlayerTime(tabId, enabled);

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={onAdd} disabled={!enabled || busy} className="w-full">
        <NotebookPen />
        {player === null ? t('notesAdd') : t('notesAddAt', formatTimestamp(player.currentTime))}
      </Button>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          defaultChecked={pauseWhileWriting}
          onChange={(event) => onPauseWhileWritingChange(event.currentTarget.checked)}
        />
        {t('notesPauseWhileWriting')}
      </label>
    </div>
  );
}
