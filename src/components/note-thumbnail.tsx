import { ImageOff } from 'lucide-react';
import { useState } from 'react';

import { NoteImageDialog } from '@/components/note-image-dialog';
import { useNoteImage } from '@/hooks/use-note-image';
import { t } from '@/lib/i18n';

interface NoteThumbnailProps {
  imageId: string;
  /** The note's time as written, such as 1:23. */
  time: string;
}

/**
 * A note's screenshot, small, under its time; a click shows it large in a dialog. Holds the
 * space of a 16:9 picture while it loads, so the list does not jump when it arrives.
 */
export function NoteThumbnail({ imageId, time }: NoteThumbnailProps) {
  const src = useNoteImage(imageId);
  const [open, setOpen] = useState(false);

  if (src === null) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ImageOff className="size-3.5" aria-hidden="true" />
        {t('notesScreenshotMissing')}
      </p>
    );
  }
  if (src === undefined) {
    return <div className="aspect-video w-full max-w-64 rounded-sm bg-muted" />;
  }
  return (
    <>
      <button
        type="button"
        className="block w-full max-w-64 overflow-hidden rounded-sm border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={t('notesEnlargeScreenshot', time)}
        title={t('notesEnlargeScreenshot', time)}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt="" className="block h-auto w-full" />
      </button>
      <NoteImageDialog src={src} time={time} open={open} onOpenChange={setOpen} />
    </>
  );
}
