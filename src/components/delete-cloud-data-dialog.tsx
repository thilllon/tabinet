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

interface DeleteCloudDataDialogProps {
  open: boolean;
  /** A deletion is running: the confirm button waits. */
  busy: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

/**
 * Asks before "Delete cloud data": Chrome confirms the Google account, then the account and
 * everything on the sync server go; what is on this device stays. It does not close while the
 * deletion runs.
 */
export function DeleteCloudDataDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: DeleteCloudDataDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('settingsAccountDeleteTitle')}</DialogTitle>
          <DialogDescription>{t('settingsAccountDeleteBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            title={t('commonCancel')}
          >
            {t('commonCancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={busy}
            title={t('settingsAccountDeleteTooltip')}
          >
            {t('settingsAccountDelete')}
          </Button>
        </DialogFooter>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
