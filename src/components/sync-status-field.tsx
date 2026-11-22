import { RefreshCw } from 'lucide-react';

import { SteadyText } from '@/components/steady-text';
import { SyncHelp } from '@/components/sync-help';
import { Button } from '@/components/ui/button';
import type { CloudSyncView } from '@/hooks/use-cloud-sync';
import { nextCheckText, syncPhaseText, syncPhaseVariants } from '@/lib/cloud-sync-status';
import { t } from '@/lib/i18n';

interface SyncStatusFieldProps {
  view: CloudSyncView;
  disabled: boolean;
  onSync(): void;
}

/**
 * The Sync row of Settings > Account: the ? help and Sync now on its first line, then the one
 * live status and the next check for other devices' changes, at full width and always in sight.
 */
export function SyncStatusField({ view, disabled, onSync }: SyncStatusFieldProps) {
  const { facts, phase, loaded } = view;
  const text = loaded ? syncPhaseText(phase) : t('commonLoading');
  const syncing = phase.kind === 'syncing';
  const check = nextCheckText(facts.checkAt);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-1">
          <p className="text-sm">{t('settingsAccountSync')}</p>
          <SyncHelp />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          disabled={disabled || syncing}
          title={t('settingsAccountSyncNowHint')}
        >
          <RefreshCw className={syncing ? 'animate-spin' : undefined} />
          {t('settingsAccountSyncNow')}
        </Button>
      </div>
      <SteadyText
        live
        text={text}
        variants={syncPhaseVariants(facts.lastSyncAt ?? Date.now(), facts.heldImages)}
        className={
          phase.kind === 'failed' || phase.kind === 'partial'
            ? 'mt-1 text-xs [&:lang(ko)]:break-keep text-destructive'
            : 'mt-1 text-xs [&:lang(ko)]:break-keep'
        }
      />
      <SteadyText
        text={check}
        variants={[nextCheckText(null), nextCheckText(facts.checkAt ?? Date.now())]}
        className="text-xs [&:lang(ko)]:break-keep text-muted-foreground"
      />
    </div>
  );
}
