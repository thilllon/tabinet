import { useId, useState } from 'react';

import { Switch } from '@/components/ui/switch';
import { useDocsAccess } from '@/hooks/use-docs-access';
import { t } from '@/lib/i18n';

/** The "Access to Google Docs" switch: the optional host permission, asked for from the click. */
export function DocsAccessField() {
  const { granted, setGranted } = useDocsAccess();
  const [refused, setRefused] = useState(false);
  const id = useId();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="font-medium" title={t('optionsDocsAccessTitle')}>
          {t('optionsDocsAccess')}
        </label>
        <Switch
          id={id}
          checked={granted === true}
          disabled={granted === undefined}
          title={t('optionsDocsAccessTitle')}
          onCheckedChange={(on) => {
            void setGranted(on).then((ok) => {
              setRefused(on && !ok);
            });
          }}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {granted === true ? t('optionsDocsAccessOn') : t('optionsDocsAccessOff')}
      </p>
      {refused && (
        <p role="alert" className="text-sm text-destructive">
          {t('optionsAccessRefused')}
        </p>
      )}
    </div>
  );
}
