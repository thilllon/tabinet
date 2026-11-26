import { useEffect, useState } from 'react';

import { listTokens, touchesTokens } from '@/lib/token-store';
import type { StoredToken } from '@/types';

/** The accounts signed in on this device (live tokens only), re-read when one changes. */
export function useSignedInAccounts(): StoredToken[] {
  const [accounts, setAccounts] = useState<StoredToken[]>([]);

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void listTokens(Date.now()).then((tokens) => {
        if (alive) {
          setAccounts(tokens);
        }
      });
    };
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'session' && touchesTokens(changes)) {
        read();
      }
    };
    read();
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  return accounts;
}
