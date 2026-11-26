import { useCallback, useEffect, useState } from 'react';

import {
  hasDocsAccess,
  removeDocsAccess,
  requestDocsAccess,
  touchesDocsAccess,
} from '@/lib/docs-access';

/**
 * Whether docs.google.com access is granted, following `chrome.permissions` (it can also change
 * at chrome://extensions). `undefined` until the first read.
 */
export function useDocsAccess(): {
  granted: boolean | undefined;
  setGranted: (on: boolean) => Promise<boolean>;
} {
  const [granted, setGrantedState] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void hasDocsAccess().then((value) => {
        if (alive) {
          setGrantedState(value);
        }
      });
    };
    const onChange = (permissions: chrome.permissions.Permissions): void => {
      if (touchesDocsAccess(permissions)) {
        read();
      }
    };
    read();
    chrome.permissions.onAdded.addListener(onChange);
    chrome.permissions.onRemoved.addListener(onChange);
    return () => {
      alive = false;
      chrome.permissions.onAdded.removeListener(onChange);
      chrome.permissions.onRemoved.removeListener(onChange);
    };
  }, []);

  // Must be called straight from the click: Chrome asks only inside a user gesture.
  const setGranted = useCallback(async (on: boolean): Promise<boolean> => {
    const ok = on ? await requestDocsAccess() : await removeDocsAccess();
    setGrantedState(await hasDocsAccess());
    return ok;
  }, []);

  return { granted, setGranted };
}
