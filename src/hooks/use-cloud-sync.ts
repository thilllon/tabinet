import { useCallback, useEffect, useState } from 'react';

import { syncNow } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY } from '@/lib/cloud-sync-state';
import {
  loadSyncFacts,
  nextReadAt,
  readingFor,
  sameFacts,
  type SyncFacts,
  syncPhase,
  type SyncPhase,
  type SyncReading,
  UNREAD,
  whenSyncEnds,
  withoutPastTimes,
} from '@/lib/cloud-sync-status';
import { reportError } from '@/lib/error-message';

/** A change's event can arrive just before the worker has set the alarm for it. */
const ALARM_SETTLE_MS = 750;

export interface CloudSyncView {
  facts: SyncFacts;
  phase: SyncPhase;
  /** False until the first reading, so no status is claimed before one is known. */
  loaded: boolean;
  /** Runs a sync now; resolves `true` when it finished as `'synced'`. Never rejects. */
  sync(): Promise<boolean>;
}

/**
 * The sync status Settings > Account shows for `account` (its token; none: nothing is read and
 * nothing shown), plus "Sync now". It reads again on three
 * things, never on a tick: a change of `cloudSyncMeta` (also the worker's runs), the end of a
 * running sync (its lock released, also by a worker that died) and the next moment the line could
 * go stale (`nextReadAt()`). A reading that changes nothing renders nothing. Listener and timers
 * live in the page and die with it.
 */
export function useCloudSync(account: string | undefined): CloudSyncView {
  const [state, setState] = useState<SyncReading>(UNREAD);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (account === undefined) {
      return;
    }
    const closed = new AbortController();
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let waitingForEnd = false;
    let reading = 0;

    const read = async () => {
      reading += 1;
      const mine = reading;
      const stored = await loadSyncFacts();
      if (closed.signal.aborted || mine !== reading) {
        return;
      }
      const now = Date.now();
      const facts = withoutPastTimes(stored, now);
      const phase = syncPhase(facts, now);
      setState((current) =>
        current.of === account &&
        current.phase.kind === phase.kind &&
        sameFacts(current.facts, facts)
          ? current
          : { of: account, facts, phase, loaded: true },
      );
      clearTimeout(staleTimer);
      const at = nextReadAt(stored, now);
      if (at !== null) {
        staleTimer = setTimeout(refresh, at - now);
      }
      if (facts.running && !waitingForEnd) {
        waitingForEnd = true;
        await whenSyncEnds(closed.signal);
        waitingForEnd = false;
        if (!closed.signal.aborted) {
          refresh();
        }
      }
    };
    function refresh() {
      read().catch((err: unknown) => reportError('sync status not read', err));
    }

    refresh();
    settleTimer = setTimeout(refresh, ALARM_SETTLE_MS);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && CLOUD_SYNC_META_KEY in changes) {
        refresh();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(refresh, ALARM_SETTLE_MS);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      closed.abort();
      clearTimeout(settleTimer);
      clearTimeout(staleTimer);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [account]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      return (await syncNow()).outcome === 'synced';
    } catch (err: unknown) {
      reportError('sync failed', err);
      return false;
    } finally {
      setSyncing(false);
    }
  }, []);

  const { facts, phase, loaded } = readingFor(state, account);
  return { facts, loaded, phase: syncing ? { kind: 'syncing' } : phase, sync };
}
