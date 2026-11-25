import { useEffect, useRef } from 'react';

import { POLICY } from '@/constants';
import { markHeldNoticed } from '@/lib/cloud-sync-state';
import type { SyncFacts } from '@/lib/cloud-sync-status';
import { formatByteLimit } from '@/lib/display-format';
import { reportError } from '@/lib/error-message';
import { formatNumber, tp } from '@/lib/i18n';

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
