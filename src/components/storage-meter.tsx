import { HardDrive, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { DeleteAllDataDialog } from '@/components/delete-all-data-dialog';
import { DeleteAllHistoryDialog } from '@/components/delete-all-history-dialog';
import { Button } from '@/components/ui/button';
import { isIndexChange } from '@/hooks/use-session-index';
import { useErrorToast } from '@/hooks/use-toasts';
import { reportError } from '@/lib/error-message';
import { t, tp } from '@/lib/i18n';
import { sessionRepo } from '@/lib/session-repo';
import {
  STORAGE_METER_ID,
  snapshotHint,
  storageSavedPart,
  storageSnapshotsPart,
  storageSegments,
  storageTotalLine,
  summarizeStorage,
} from '@/lib/storage-meter';
import type { SessionSummary } from '@/types';

interface StorageMeterProps {
  /** The index, straight from `useSessionIndex`: the saved/snapshot split and the refresh cue. */
  summaries: SessionSummary[];
  /** "Deleted all session data." - shown as a toast by the app. */
  onNotice(message: string): void;
}

/**
 * How much of this device the extension is using: one `getBytesInUse()` total, split into saved
 * sessions and automatic snapshots from the index's `bytes` fields, plus the hint that names the
 * snapshots when they are what is filling the disk.
 *
 * Two remedies sit below it, bottom-left, because this is where a quota notice sends the user:
 * "Delete snapshots", the one that actually frees the space and keeps every saved session,
 * and only then the all-or-nothing "Delete all session data". The first clears every snapshot
 * that is not protected, behind its own confirm (`DeleteAllHistoryDialog`).
 *
 * The total is re-read whenever the index changes - every write goes through `sessionRepo`, which
 * rewrites `sessionIndex`, and `useSessionIndex` turns that `storage.onChanged` into a new
 * `summaries` array - so saving, deleting, importing or pruning all move the bar.
 */
export function StorageMeter({ summaries, onNotice }: StorageMeterProps) {
  const [bytes, setBytes] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useErrorToast(error);
  const [confirming, setConfirming] = useState(false);
  const [confirmingHistory, setConfirmingHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setBytes(await chrome.storage.local.getBytesInUse());
      setError(undefined);
    } catch (err) {
      setError(reportError('storage', err));
    }
  }, []);

  // Measured once on mount and again on every `sessionIndex` write - which is every save,
  // delete, import, prune and "Delete all session data", since `sessionRepo` rewrites the index
  // with each of them. (The saved/snapshot split needs no listener: `summaries` is a prop.)
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (isIndexChange(changes, area)) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    void refresh();
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [refresh]);

  const breakdown = summarizeStorage(summaries, bytes ?? 0);
  const segments = storageSegments(breakdown);
  const hint = snapshotHint(breakdown);

  const deleteEverything = () => {
    setConfirming(false);
    setBusy(true);
    void (async () => {
      try {
        await sessionRepo.removeAll();
        setError(undefined);
        onNotice(t('storageDeletedAllNotice'));
      } catch (err) {
        setError(reportError('storage', err));
      } finally {
        setBusy(false);
        await refresh();
      }
    })();
  };

  const deleteUnprotectedSnapshots = () => {
    setConfirmingHistory(false);
    setBusy(true);
    void (async () => {
      try {
        const removed = await sessionRepo.removeAllHistory({ unprotectedOnly: true });
        setError(undefined);
        onNotice(tp('storageDeletedUnprotectedNotice', removed.length));
      } catch (err) {
        setError(reportError('storage', err));
      } finally {
        setBusy(false);
        await refresh();
      }
    })();
  };

  return (
    <section
      id={STORAGE_METER_ID}
      // Focus target for the "Show storage use" button on a quota notice; never in the tab order.
      tabIndex={-1}
      className="mt-3 border-t pt-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      aria-labelledby="storage-meter-heading"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id="storage-meter-heading" className="flex items-center gap-1.5 text-xs font-semibold">
          <HardDrive className="size-3.5 text-muted-foreground" />
          {t('storageHeading')}
        </h3>
        {bytes === undefined ? (
          <p className="text-xs text-muted-foreground">{t('storageMeasuring')}</p>
        ) : (
          // Each half after a dot in its colour on the bar below, so the bar needs no other key.
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{storageTotalLine(breakdown)}</span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
              {storageSavedPart(breakdown)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary/50" aria-hidden="true" />
              {storageSnapshotsPart(breakdown)}
            </span>
          </p>
        )}
      </div>

      {/* Decorative: the same numbers are in the line above, spelled out after dots in these colours. */}
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded bg-muted" aria-hidden="true">
        <div className="h-full bg-primary" style={{ width: `${segments.saved}%` }} />
        <div className="h-full bg-primary/50" style={{ width: `${segments.snapshots}%` }} />
        <div className="h-full bg-muted-foreground/25" style={{ width: `${segments.other}%` }} />
      </div>

      {hint !== undefined && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
      {/* Bottom-left, under what they act on: the numbers and the hint come first. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          // Nothing to free: every snapshot is protected, or there are none.
          disabled={busy || breakdown.unprotectedSnapshotCount === 0}
          onClick={() => setConfirmingHistory(true)}
          title={t('storageDeleteUnprotectedTooltip')}
        >
          <Trash2 />
          {t('storageDeleteUnprotected')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setConfirming(true)}
          title={t('storageDeleteAllDataTooltip')}
        >
          <Trash2 />
          {t('storageDeleteAllData')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('storageDeleteSnapshotsNote')}</p>

      <DeleteAllHistoryDialog
        count={breakdown.unprotectedSnapshotCount}
        open={confirmingHistory}
        onOpenChange={setConfirmingHistory}
        onConfirm={deleteUnprotectedSnapshots}
      />

      <DeleteAllDataDialog
        open={confirming}
        savedCount={breakdown.savedCount}
        snapshotCount={breakdown.snapshotCount}
        bytes={breakdown.total}
        onOpenChange={setConfirming}
        onConfirm={deleteEverything}
      />
    </section>
  );
}
