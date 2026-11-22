import { RefreshCw } from 'lucide-react';

import { SteadyText } from '@/components/steady-text';
import { SyncHelp } from '@/components/sync-help';
import { Button } from '@/components/ui/button';
import type { CloudSyncView } from '@/hooks/use-cloud-sync';
import {
  type SyncPhase,
  nextCheckAt,
  nextCheckText,
  nextCheckVariants,
  syncPhaseText,
  syncPhaseVariants,
} from '@/lib/cloud-sync-status';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SyncStatusFieldProps {
  view: CloudSyncView;
  disabled: boolean;
  onSync(): void;
}

const LINE = 'text-xs tabular-nums [&:lang(ko)]:break-keep';
/** The statuses shown in red. */
const PROBLEMS: ReadonlySet<SyncPhase['kind']> = new Set([
  'failed',
  'partial',
  'tooLarge',
  'unreadable',
]);

/**
 * The Sync row of Settings > Account: the ? help and Sync now on its first line, then the one
 * live status and the next check for other devices' changes, at full width and always in sight.
 * Sync now stays focusable while a sync runs (`aria-disabled`): the worker starts runs on its own,
 * and disabling the button would drop the keyboard focus resting on it.
 */
export function SyncStatusField({ view, disabled, onSync }: SyncStatusFieldProps) {
  const { facts, phase, loaded } = view;
  const text = loaded ? syncPhaseText(phase) : t('commonLoading');
  const syncing = phase.kind === 'syncing';
  const check = nextCheckText(nextCheckAt(facts));
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
          onClick={syncing ? undefined : onSync}
          disabled={disabled}
          aria-disabled={syncing || undefined}
          className="aria-disabled:cursor-default aria-disabled:opacity-50"
          title={t('settingsAccountSyncNowHint')}
        >
          <RefreshCw className={syncing ? 'animate-spin' : undefined} />
          {t('settingsAccountSyncNow')}
        </Button>
      </div>
      <SteadyText
        live
        text={text}
        variants={syncPhaseVariants(facts)}
        className={cn(LINE, 'mt-1', PROBLEMS.has(phase.kind) && 'text-destructive')}
      />
      <SteadyText
        text={check}
        variants={nextCheckVariants()}
        className={cn(LINE, 'text-muted-foreground')}
      />
    </div>
  );
}
