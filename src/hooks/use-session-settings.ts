import { useCallback, useEffect, useRef, useState } from 'react';

import { reportError } from '@/lib/error-message';
import { SETTINGS_KEY, sessionRepo } from '@/lib/session-repo';
import { DEFAULT_SESSION_SETTINGS, type SessionSettings } from '@/types';

/**
 * Does this `chrome.storage.onChanged` event touch `sessionSettings`? Mirrors `isIndexChange`
 * (src/hooks/use-session-index.ts) for the settings key: session settings are device-local
 * and live in `chrome.storage.local` only, so a `sync` change of the same name is never ours.
 */
export function isSettingsChange(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): boolean {
  return area === 'local' && Object.hasOwn(changes, SETTINGS_KEY);
}

interface SessionSettingsState {
  /** The stored settings; `DEFAULT_SESSION_SETTINGS` until the first read resolves. */
  settings: SessionSettings;
  loading: boolean;
  error?: string;
  /**
   * Writes a partial update through `sessionRepo.setSettings()` (which normalises it). Resolves
   * `true` when the write landed - a failure is reported through `error` rather than thrown, so
   * callers that confirm a save to the user need this to tell the two apart.
   */
  update(patch: Partial<SessionSettings>): Promise<boolean>;
}

/**
 * `sessionSettings` for an extension page. The Settings dialog uses this; another
 * app tab can write while it is open, so the hook re-reads on every `chrome.storage.onChanged`
 * for the settings key. The service worker
 * watches the same key and re-arms the history alarm itself - this hook must never touch
 * `chrome.alarms`, and never writes storage except through `sessionRepo`.
 */
export function useSessionSettings(): SessionSettingsState {
  const [settings, setSettings] = useState<SessionSettings>(DEFAULT_SESSION_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  // Generation counter: guards getSettings() *results* that settle out of order - an update()
  // and the storage.onChanged it triggers start two reads, and whichever started last must win.
  // Same pattern (and same reasoning) as useSessionIndex's genRef.
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const stored = await sessionRepo.getSettings();
      if (gen !== genRef.current) {
        return;
      }
      setSettings(stored);
      setError(undefined);
    } catch (err) {
      if (gen !== genRef.current) {
        return;
      }
      setError(reportError('session settings', err));
    } finally {
      if (gen === genRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (isSettingsChange(changes, area)) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    void refresh();

    return () => {
      // Invalidate any refresh() still in flight for this instance (see genRef's comment above).
      genRef.current += 1;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [refresh]);

  const update = useCallback<SessionSettingsState['update']>(
    async (patch) => {
      try {
        await sessionRepo.setSettings(patch);
      } catch (err) {
        setError(reportError('session settings', err));
        return false;
      }
      // Re-read rather than merging the patch locally: setSettings() normalises what it stores
      // (an out-of-range interval falls back to the default), so the controls must show what was
      // actually written. storage.onChanged fires for this write too; genRef settles the race.
      await refresh();
      return true;
    },
    [refresh],
  );

  return { settings, loading, error, update };
}
