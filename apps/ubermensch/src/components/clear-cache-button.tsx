import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { clearCache } from '@/lib/session-cache';

/** Drops every cached folder name, so the next path is read from Drive again. */
export function ClearCacheButton() {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        title={t('optionsClearCacheTitle')}
        onClick={() => {
          void clearCache().then(() => {
            setDone(true);
          });
        }}
      >
        {t('optionsClearCache')}
      </Button>
      {done && (
        <output className="text-sm text-muted-foreground">{t('optionsCacheCleared')}</output>
      )}
    </div>
  );
}
