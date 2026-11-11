import { useEffect, useRef, useState } from 'react';

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
import { Label } from '@/components/ui/label';
import { joinSentences, t, tp } from '@/lib/i18n';
import { countTabs, formatRestoreDestination } from '@/lib/restore-messages';
import { isLazyRestore, type RestoreTarget } from '@/lib/session-restore';
import type { Session, SessionSettings } from '@/types';

export interface PendingRestore {
  session: Session;
  target: RestoreTarget;
  /** The stored `restoreLazy` setting when the confirm was requested; seeds the checkbox. */
  restoreLazy: SessionSettings['restoreLazy'];
}

interface RestoreConfirmDialogProps {
  pending?: PendingRestore;
  onConfirm(lazy: SessionSettings['restoreLazy']): void;
  onCancel(): void;
}

export function RestoreConfirmDialog({ pending, onConfirm, onCancel }: RestoreConfirmDialogProps) {
  const [lazy, setLazy] = useState(true);
  // Radix keeps DialogContent mounted through its closing animation; once `pending` goes back to
  // undefined, fall back to the last non-undefined value so the dialog's title/body don't flash
  // "Restore 0 tabs?" while it fades out.
  const lastPendingRef = useRef<PendingRestore | undefined>(undefined);

  useEffect(() => {
    if (pending !== undefined) {
      lastPendingRef.current = pending;
      // Seed the checkbox from the stored setting each time a new confirm opens, rather than
      // carrying over whatever the previous confirm (possibly for a different session) left it
      // at: 'always' -> checked, 'never' -> unchecked, 'auto' -> what the planner would do for
      // this many tabs. The checkbox's answer is then passed back as an explicit override.
      setLazy(isLazyRestore(pending.restoreLazy, countTabs(pending.session)));
    }
  }, [pending]);

  const shown = pending ?? lastPendingRef.current;
  const tabCount = shown === undefined ? 0 : countTabs(shown.session);

  return (
    <Dialog
      open={pending !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{tp('sessionRestoreTitle', tabCount)}</DialogTitle>
          <DialogDescription>
            {joinSentences(
              shown === undefined ? '' : formatRestoreDestination(shown.session, shown.target),
              t('sessionRestoreBody'),
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <input
            id="restore-lazy"
            type="checkbox"
            className="size-4"
            checked={lazy}
            onChange={(event) => setLazy(event.target.checked)}
          />
          <Label htmlFor="restore-lazy">{t('sessionRestoreLazyLabel')}</Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('commonCancel')}
          </Button>
          <Button onClick={() => onConfirm(lazy ? 'always' : 'never')}>
            {t('sessionRestoreButton')}
          </Button>
        </DialogFooter>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
