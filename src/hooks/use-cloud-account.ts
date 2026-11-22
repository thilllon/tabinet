import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type AccountState,
  accountState,
  checkKeySetup,
  CLOUD_ACCOUNT_KEY,
  CLOUD_SYNC_KEY,
  loadLiveCloudAccount,
  loadSyncKey,
  showsSyncRow,
} from '@/lib/cloud-auth';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { reportError } from '@/lib/error-message';
import type { CloudAccount, CloudKeySetup } from '@/types';

export interface CloudAccountView {
  /** `'unknown'` while the stored account is read or the server is asked about the passphrase. */
  state: AccountState | 'unknown';
  account: CloudAccount | null;
  /** The server's passphrase setup, once known (needed to unlock). */
  keySetup: CloudKeySetup | null | undefined;
  /** Whether the Sync row shows (`showsSyncRow()`): also before the server answered, or while it cannot. */
  syncRow: boolean;
  /** Why the server could not be asked, in the UI language; cleared by `refresh()`. */
  error: string | undefined;
  /** Reads everything again (after sign-in, a passphrase, sign-out, or a failure). */
  refresh(): void;
  /**
   * Records the setup the server just answered with for the account holding `token`, without
   * waiting for the next read to ask it again.
   */
  setKeySetup(setup: CloudKeySetup | null | undefined, token: string | undefined): void;
}

/**
 * The cloud sync account as Settings shows it. Reads the stored account (forgetting an expired
 * one) and key, asks the server for the account's passphrase setup on every read while signed in
 * (a 401 signs this device out; a key that does not open the setup is dropped), and follows `cloudAccount` /
 * `cloudSyncKey` in `chrome.storage.onChanged`, so another app tab signing out shows at once.
 * The listener lives in the page and dies with it.
 */
export function useCloudAccount(): CloudAccountView {
  const configured = isCloudSyncEnabled();
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [keySetup, setKeySetup] = useState<CloudKeySetup | null | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  /** The token the known `keySetup` belongs to: a setup is never shown for another account. */
  const setupToken = useRef<string | undefined>(undefined);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const recordKeySetup = useCallback(
    (setup: CloudKeySetup | null | undefined, token: string | undefined) => {
      setupToken.current = setup === undefined ? undefined : token;
      setKeySetup(setup);
    },
    [],
  );

  useEffect(() => {
    if (!configured) {
      return;
    }
    let live = true;
    setError(undefined);
    void (async () => {
      try {
        const [storedAccount, key] = await Promise.all([
          loadLiveCloudAccount(Date.now()),
          loadSyncKey(),
        ]);
        if (!live) {
          return;
        }
        setAccount(storedAccount);
        setHasKey(key !== null);
        if (storedAccount?.token !== setupToken.current) {
          // Whatever the server said about the passphrase belonged to another account.
          setupToken.current = undefined;
          setKeySetup(undefined);
        }
        setLoaded(true);
        if (storedAccount === null) {
          return;
        }
        const answer = await checkKeySetup(storedAccount);
        if (live) {
          setupToken.current = storedAccount.token;
          setKeySetup(answer.keySetup);
          setHasKey(answer.keyKept);
        }
      } catch (err: unknown) {
        if (live) {
          setLoaded(true);
          setError(reportError('cloud account not read', err));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [configured, generation]);

  useEffect(() => {
    if (!configured) {
      return;
    }
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (CLOUD_ACCOUNT_KEY in changes || CLOUD_SYNC_KEY in changes)) {
        refresh();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [configured, refresh]);

  const state = loaded
    ? accountState({ configured, account, hasLocalKey: hasKey, keySetup, now: Date.now() })
    : configured
      ? 'unknown'
      : 'unconfigured';

  const syncRow = showsSyncRow(state, account, hasKey, Date.now());

  return { state, syncRow, account, keySetup, error, refresh, setKeySetup: recordKeySetup };
}
