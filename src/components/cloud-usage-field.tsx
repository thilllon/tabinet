import { SettingsField } from '@/components/settings-field';
import { POLICY } from '@/constants';
import { cloudUsageText } from '@/lib/cloud-usage';
import { t } from '@/lib/i18n';
import type { Usage } from '@/types';

interface CloudUsageFieldProps {
  usage: Usage | null;
}

/** The Cloud storage row (#261): `12.3 MB / 50 MB`, nothing until a usage is known. */
export function CloudUsageField({ usage }: CloudUsageFieldProps) {
  if (usage === null) {
    return null;
  }
  return (
    <SettingsField label={t('settingsAccountUsage')}>
      <span className="text-sm tabular-nums" title={t('settingsAccountUsageTitle')}>
        {cloudUsageText(usage, POLICY.account.storageBytes)}
      </span>
    </SettingsField>
  );
}
