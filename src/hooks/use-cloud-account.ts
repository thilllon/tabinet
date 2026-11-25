import { useCallback, useEffect, useState } from 'react';

import { accountState, forgetExpiredAccount, loadCloudState, refreshMe } from '@/lib/cloud-auth';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import {
  CLOUD_ACCOUNT_KEY,
  CLOUD_KEY_KEY,
  CLOUD_OWNER_KEY,
  upgradeCloudStorage,
} from '@/lib/cloud-storage';
import { reportError } from '@/lib/error-message';
import { t } from '@/lib/i18n';
import type {
  AccountState,
  CloudAccountV2,
  CloudKeyV2,
  CloudOwnerV2,
  Usage,
  WireKey,
} from '@/types';

export interface CloudAccountView {
  state: AccountState;
  account: CloudAccountV2 | null;
  owner: CloudOwnerV2 | null;
  key: CloudKeyV2 | null;
  /** The key the server last reported for this account; `undefined` while unknown. */
  server: WireKey | undefined;
  usage: Usage | null;
  /** Why the server could not be asked (or a rollback), in the UI language; cleared by `refresh()`. */
  error: string | undefined;
  /** Reads everything again (after an action, or Try again). */
  refresh(): void;
}

/** The rollback warning is shown once per page. */
let rollbackShown = false;

interface Read {
  loaded: boolean;
  account: CloudAccountV2 | null;
  owner: CloudOwnerV2 | null;
  key: CloudKeyV2 | null;
  /** The token the server answer belongs to: never shown for another account. */
  serverOf: string | undefined;
  server: WireKey | undefined;
  usage: Usage | null;
  error: string | undefined;
}

const UNREAD: Read = {
  loaded: false,
  account: null,
  owner: null,
  key: null,
  serverOf: undefined,
  server: undefined,
  usage: null,
  error: undefined,
};

/**
 * The cloud sync account as Settings shows it (spec 9.1, 9.3). Runs the v1 upgrade (a page can
 * open before `onInstalled` ran), forgets an expired account (its key stays), reads the stored
 * account, key and owner, and asks the server (`GET /v2/me`) while signed in: a higher generation
 * raises the stored one, a lower one is reported once per page, a 401 removes that bearer only.
 * Follows the three account keys in `chrome.storage.onChanged`; the listener lives in the page.
 */
export function useCloudAccount(): CloudAccountView {
  const configured = isCloudSyncEnabled();
  const [read, setRead] = useState<Read>(UNREAD);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!configured) {
      return;
    }
    let live = true;
    void (async () => {
      try {
        await upgradeCloudStorage();
        await forgetExpiredAccount();
        const stored = await loadCloudState();
        if (!live) {
          return;
        }
        setRead((current) => ({
          ...current,
          loaded: true,
          account: stored.account,
          owner: stored.owner,
          key: stored.key,
          error: undefined,
          ...(stored.account?.token === current.serverOf
            ? {}
            : { serverOf: undefined, server: undefined, usage: null }),
        }));
        const account = stored.account;
        if (account === null || account.expiresAt <= Date.now()) {
          return;
        }
        const { answer, rollback } = await refreshMe(account);
        if (!live) {
          return;
        }
        const after = await loadCloudState();
        let error: string | undefined;
        if (rollback && !rollbackShown) {
          rollbackShown = true;
          error = t('settingsAccountRollback');
        }
        setRead((current) => ({
          ...current,
          account: after.account,
          owner: after.owner,
          key: after.key,
          serverOf: account.token,
          server: after.account?.token === account.token ? answer.key : undefined,
          usage: answer.usage,
          error,
        }));
      } catch (err: unknown) {
        if (live) {
          const stored = await loadCloudState().catch(() => null);
          setRead((current) => ({
            ...current,
            loaded: true,
            ...(stored === null ? {} : stored),
            error: reportError('cloud account not read', err),
          }));
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
      if (
        area === 'local' &&
        (CLOUD_ACCOUNT_KEY in changes || CLOUD_KEY_KEY in changes || CLOUD_OWNER_KEY in changes)
      ) {
        refresh();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [configured, refresh]);

  const server =
    read.account !== null && read.serverOf === read.account.token ? read.server : undefined;
  const state = accountState({
    configured,
    loaded: read.loaded,
    now: Date.now(),
    account: read.account,
    key: read.key,
    server,
  });
  return {
    state,
    account: read.account,
    owner: read.owner,
    key: read.key,
    server,
    usage: read.usage,
    error: read.error,
    refresh,
  };
}
