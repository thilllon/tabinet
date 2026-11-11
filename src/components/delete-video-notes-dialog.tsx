import { DialogCloseButton } from '@/components/dialog-close-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { t, tp } from '@/lib/i18n';

interface DeleteVideoNotesDialogProps {
  /** The video's title, as the notes page shows it. */
  title: string;
  /** How many notes go with it. */
  count: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

/** Asks before every note on a video, screenshots included, is deleted. */
export function DeleteVideoNotesDialog({
  title,
  count,
  open,
  onOpenChange,
  onConfirm,
}: DeleteVideoNotesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('notesDeleteAllTitle')}</DialogTitle>
          <DialogDescription>{tp('notesDeleteAllBody', count, title)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('commonCancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('commonDelete')}
          </Button>
        </DialogFooter>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
