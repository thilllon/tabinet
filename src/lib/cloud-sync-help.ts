/**
 * The text behind the ? in Settings > Account. Every number comes from the constant the sync
 * really runs on, so the explanation cannot drift from the timing it explains.
 */
import { CLOUD_IMAGE_LIMIT } from '@/constants';
import { SYNC_FALLBACK_MS, SYNC_ITEM_MAX_KB, SYNC_PERIOD_MINUTES } from '@/lib/cloud-sync';
import { SYNC_MAX_WAIT_MS } from '@/lib/cloud-sync-scheduler';
import { formatNumber, t, tp } from '@/lib/i18n';

export interface SyncHelpText {
  intro: string;
  sections: { title: string; points: string[] }[];
}

export function syncHelp(): SyncHelpText {
  const fallback = SYNC_FALLBACK_MS / 1000;
  return {
    intro: t('settingsAccountHelpIntro'),
    sections: [
      {
        title: t('settingsAccountHelpSendTitle'),
        points: [
          tp('settingsAccountHelpSendChange', SYNC_MAX_WAIT_MS / 1000),
          t('settingsAccountHelpSendSignIn'),
          tp('settingsAccountHelpSendPaused', fallback),
        ],
      },
      {
        title: t('settingsAccountHelpReceiveTitle'),
        points: [
          tp('settingsAccountHelpReceiveEvery', SYNC_PERIOD_MINUTES),
          t('settingsAccountHelpReceiveWhy'),
        ],
      },
      {
        title: t('settingsAccountHelpNowTitle'),
        points: [t('settingsAccountHelpNowButton'), t('settingsAccountHelpNowOpen')],
      },
      {
        title: t('settingsAccountHelpAwayTitle'),
        points: [
          tp('settingsAccountHelpAwayOffline', SYNC_PERIOD_MINUTES, formatNumber(fallback)),
          t('settingsAccountHelpAwayClosed'),
        ],
      },
      {
        title: t('settingsAccountHelpWhatTitle'),
        points: [
          tp('settingsAccountHelpWhatSynced', CLOUD_IMAGE_LIMIT),
          t('settingsAccountHelpWhatLocal'),
          t('settingsAccountHelpWhatTooLarge', formatNumber(SYNC_ITEM_MAX_KB)),
        ],
      },
      {
        title: t('settingsAccountHelpConflictTitle'),
        points: [t('settingsAccountHelpConflictNewer'), t('settingsAccountHelpConflictWhole')],
      },
    ],
  };
}
