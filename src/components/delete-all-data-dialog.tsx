import { useEffect, useState } from 'react';

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
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { formatBytes } from '@/lib/display-format';
import { t, tp } from '@/lib/i18n';

interface DeleteAllDataDialogProps {
  open: boolean;
  savedCount: number;
  snapshotCount: number;
  /** Total bytes the meter is showing; named in the first step so the size is not a surprise. */
  bytes: number;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

/**
 * Two-step confirm for `sessionRepo.removeAll()`. Step one says what
 * goes and what stays; step two is the point of no return and is the only place the destructive
 * button appears - a single mis-click can never reach it.
 */
export function DeleteAllDataDialog({
  open,
  savedCount,
  snapshotCount,
  bytes,
  onOpenChange,
  onConfirm,
}: DeleteAllDataDialogProps) {
  const [confirming, setConfirming] = useState(false);

  // Every opening starts at step one, including one right after a cancel on step two.
  useEffect(() => {
    if (open) {
      setConfirming(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        {confirming ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('storageDeleteAllFinalTitle')}</DialogTitle>
              <DialogDescription>
                {t(
                  isCloudSyncEnabled()
                    ? 'storageDeleteAllFinalBodySynced'
                    : 'storageDeleteAllFinalBody',
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                {t('storageBack')}
              </Button>
              <Button variant="destructive" onClick={onConfirm}>
                {t('storageDeleteEverything')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('storageDeleteAllTitle')}</DialogTitle>
              <DialogDescription>
                {t(
                  isCloudSyncEnabled() ? 'storageDeleteAllBodySynced' : 'storageDeleteAllBody',
                  tp('storageSavedSessionCount', savedCount),
                  tp('storageSnapshotCount', snapshotCount),
                  formatBytes(bytes),
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('commonCancel')}
              </Button>
              <Button variant="destructive" onClick={() => setConfirming(true)}>
                {t('storageContinue')}
              </Button>
            </DialogFooter>
          </>
        )}
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
