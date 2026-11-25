import { useEffect, useRef } from 'react';

import { SettingsField } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

interface ConfirmAccountFieldProps {
  /** Whose cloud this device's data last went to, and the account just signed in. */
  ownerEmail: string;
  email: string;
  busy: boolean;
  onKeep(): void;
  onAdd(): void;
  onDelete(): void;
}

/**
 * The account question (spec 9.1, 9.3): this device last synced with another account, so nothing
 * is uploaded before the person says yes. "No, keep it here" is the default, focused and primary.
 */
export function ConfirmAccountField({
  ownerEmail,
  email,
  busy,
  onKeep,
  onAdd,
  onDelete,
}: ConfirmAccountFieldProps) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keep.current?.focus();
  }, []);
  return (
    <SettingsField label={t('settingsAccountGoogle')} hint={t('settingsAccountSignedInAs', email)}>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('settingsAccountConfirm')}</p>
        <p className="text-xs text-muted-foreground">
          {t('settingsAccountConfirmBody', ownerEmail, email)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={keep}
            size="sm"
            onClick={onKeep}
            disabled={busy}
            title={t('settingsAccountKeepHereTitle')}
          >
            {t('settingsAccountKeepHere')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onAdd}
            disabled={busy}
            title={t('settingsAccountAddDataTitle')}
          >
            {t('settingsAccountAddData')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            title={t('settingsAccountDeleteTooltip')}
          >
            {t('settingsAccountDelete')}
          </Button>
        </div>
      </div>
    </SettingsField>
  );
}
