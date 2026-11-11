import { DialogCloseButton } from '@/components/dialog-close-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

interface NoteImageDialogProps {
  /** The screenshot, an image data URL. */
  src: string;
  /** The note's time as written, such as 1:23. */
  time: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** A note's screenshot at full width of the panel, over everything else. */
export function NoteImageDialog({ src, time, open, onOpenChange }: NoteImageDialogProps) {
  const title = t('notesScreenshotAt', time);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // The picture is the whole content; there is nothing to describe beyond the title.
        aria-describedby={undefined}
        className="gap-3 p-3 pt-4 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <img src={src} alt={title} className="h-auto w-full rounded-sm border" />
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
