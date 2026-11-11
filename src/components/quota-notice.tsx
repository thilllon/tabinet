import { TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

interface QuotaNoticeProps {
  /** Scrolls the storage meter into view and focuses it (see `revealStorageMeter`). */
  onShowStorage(): void;
}

/**
 * What a failed write says when the failure was the storage quota: one
 * sentence the user can act on, and a way straight to the meter and its "Delete all session
 * data" / snapshot-pruning controls. Used by the save, import and "Save as session" paths.
 */
export function QuotaNotice({ onShowStorage }: QuotaNoticeProps) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <TriangleAlert className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t('storageQuotaNotice')}</span>
      <Button size="xs" variant="outline" onClick={onShowStorage}>
        {t('storageShowStorageUse')}
      </Button>
    </div>
  );
}
