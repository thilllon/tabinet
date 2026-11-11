import { Camera, NotebookPen } from 'lucide-react';

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
  /** Adds a note holding a picture of the video as it is now. */
  onScreenshot(): void;
}

/**
 * "Add note at 1:23", with the time following the video, "Screenshot" (a note holding the frame
 * on screen, at that time), and the "Pause while I write" box. The
 * time is read every second by this component alone, so the notes under it are not redrawn.
 */
export function AddNoteBar({
  tabId,
  enabled,
  busy,
  pauseWhileWriting,
  onPauseWhileWritingChange,
  onAdd,
  onScreenshot,
}: AddNoteBarProps) {
  const player = usePlayerTime(tabId, enabled);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button onClick={onAdd} disabled={!enabled || busy} className="min-w-0 flex-1">
          <NotebookPen />
          {player === null ? t('notesAdd') : t('notesAddAt', formatTimestamp(player.currentTime))}
        </Button>
        <Button
          variant="outline"
          onClick={onScreenshot}
          disabled={!enabled || busy}
          title={t('notesScreenshotTitle')}
        >
          <Camera />
          {t('notesScreenshot')}
        </Button>
      </div>
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
