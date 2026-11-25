import { useEffect, useRef } from 'react';

import { POLICY } from '@/constants';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import {
  CLOUD_SYNC_META_KEY,
  markConflictsNoticed,
  markHeldNoticed,
  readSyncNotices,
} from '@/lib/cloud-sync-state';
import type { SyncFacts } from '@/lib/cloud-sync-status';
import { formatByteLimit } from '@/lib/display-format';
import { reportError } from '@/lib/error-message';
import { formatNumber, t, tp } from '@/lib/i18n';

/**
 * The toasts sync owes the person once (spec 10.7): items held for the storage cap and for the
 * screenshot cap, each said once per non-empty set, then remembered as said (`markHeldNoticed()`).
 */
export function useSyncNotices(facts: SyncFacts, onNotice: (message: string) => void): void {
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const shown = useRef(false);
  const { storage, screenshots } = facts.heldByReason;
  const { heldNoticed } = facts;
  useEffect(() => {
    if (storage === 0 && screenshots === 0) {
      shown.current = false;
      return;
    }
    if (heldNoticed || shown.current) {
      return;
    }
    shown.current = true;
    if (storage > 0) {
      notice.current(
        tp('settingsAccountStorageHeld', storage, formatByteLimit(POLICY.account.storageBytes)),
      );
    }
    if (screenshots > 0) {
      notice.current(
        tp('settingsAccountImagesHeld', screenshots, formatNumber(POLICY.account.screenshots)),
      );
    }
    markHeldNoticed().catch((err: unknown) => reportError('held items notice', err));
  }, [storage, screenshots, heldNoticed]);
}

/**
 * The app page's toast for memo conflicts (spec 12.1): one keyed toast whenever sync kept both
 * texts of a memo since the last one said (`conflicts > conflictsNoticed`), then remembered as
 * said (`markConflictsNoticed()`). Read on load and on every change of the sync bookkeeping;
 * nothing at all while sync is unconfigured.
 */
export function useConflictNotice(onNotice: (message: string, key?: string) => void): void {
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(() => {
    if (!isCloudSyncEnabled()) {
      return;
    }
    let live = true;
    let said = 0;
    const check = () => {
      readSyncNotices().then(
        ({ conflicts, conflictsNoticed }) => {
          if (!live || conflicts <= Math.max(conflictsNoticed, said)) {
            return;
          }
          said = conflicts;
          notice.current(t('memoConflictNotice'), 'memo-conflict');
          markConflictsNoticed(conflicts).catch((err: unknown) =>
            reportError('memo conflict notice', err),
          );
        },
        (err: unknown) => reportError('memo conflict notice', err),
      );
    };
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && Object.hasOwn(changes, CLOUD_SYNC_META_KEY)) {
        check();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    check();
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
}
