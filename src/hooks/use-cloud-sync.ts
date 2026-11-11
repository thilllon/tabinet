import { useCallback, useEffect, useState } from 'react';

import { syncNow } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY, loadSyncStatus, type SyncStatus } from '@/lib/cloud-sync-state';
import { reportError } from '@/lib/error-message';

export interface CloudSyncView extends SyncStatus {
  /** A sync started here is running. */
  syncing: boolean;
  /** Runs a sync now; resolves `true` when it finished as `'synced'`. Never rejects. */
  sync(): Promise<boolean>;
}

/**
 * The sync status Settings > Account shows while ready: when the last sync finished and why it
 * did not, how many screenshots the server refused over its cap, following `cloudSyncMeta` in `chrome.storage.onChanged` (a sync the worker runs shows
 * at once), plus "Sync now". The listener lives in the page and dies with it.
 */
export function useCloudSync(enabled: boolean): CloudSyncView {
  const [status, setStatus] = useState<SyncStatus>({
    lastSyncAt: null,
    lastError: undefined,
    heldImages: 0,
    heldImagesNoticed: false,
  });
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let live = true;
    const read = () => {
      loadSyncStatus().then(
        (next) => {
          if (live) {
            setStatus(next);
          }
        },
        (err: unknown) => reportError('sync status not read', err),
      );
    };
    read();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && CLOUD_SYNC_META_KEY in changes) {
        read();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [enabled]);

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

  return { ...status, syncing, sync };
}
