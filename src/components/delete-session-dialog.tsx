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
import { t } from '@/lib/i18n';

interface DeleteSessionDialogProps {
  name: string;
  /** Overridden by the snapshot view, which deletes a snapshot rather than a session. */
  title?: string;
  /**
   * A saved session, whose deletion reaches the sync server and the other devices once sync is in
   * use. Snapshots never sync, so the snapshot view leaves this off.
   */
  synced?: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
  /**
   * Radix's close-time focus hand-off (defaults to the trigger). Call `event.preventDefault()`
   * and focus something else when the trigger is about to unmount.
   */
  onCloseAutoFocus?(event: Event): void;
}

export function DeleteSessionDialog({
  name,
  title = t('sessionDeleteTitle'),
  synced = false,
  open,
  onOpenChange,
  onConfirm,
  onCloseAutoFocus,
}: DeleteSessionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(synced ? 'sessionDeleteBodySynced' : 'sessionDeleteBody', name)}
          </DialogDescription>
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
