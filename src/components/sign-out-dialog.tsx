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

interface SignOutDialogProps {
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

/**
 * Asks before a sign-out that removes the data key from this device (spec 9.2): the passphrase is
 * then needed to sync here again, and a last unlocked device with a forgotten passphrase loses the
 * cloud copy. It does not close while the sign-out runs.
 */
export function SignOutDialog({ open, busy, onOpenChange, onConfirm }: SignOutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('settingsAccountSignOutTitle')}</DialogTitle>
          <DialogDescription>{t('settingsAccountSignOutBody')}</DialogDescription>
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
            title={t('settingsAccountSignOutButtonTitle')}
          >
            {t('settingsAccountSignOut')}
          </Button>
        </DialogFooter>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
