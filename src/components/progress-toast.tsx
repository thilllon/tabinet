import { LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { RestoreProgress } from '@/hooks/use-restore';
import { formatNumber, joinFacts, t, tp } from '@/lib/i18n';
import {
  formatRate,
  formatRestoreSummary,
  formatWindowLine,
  lazyRestoreSummaryHint,
  restoreErrorLine,
  splitRestoreErrors,
} from '@/lib/restore-messages';
import type { RestoreResult } from '@/lib/session-restore';

interface ProgressToastProps {
  progress?: RestoreProgress;
  result?: RestoreResult;
  /** True while a cancel has been requested and the running restore is still winding down. */
  cancelling: boolean;
  /** True when `result` ended because the running restore was cancelled. */
  cancelled: boolean;
  onCancel(): void;
  onDismiss(): void;
}

export function ProgressToast({
  progress,
  result,
  cancelling,
  cancelled,
  onCancel,
  onDismiss,
}: ProgressToastProps) {
  if (progress === undefined && result === undefined) {
    return null;
  }

  const { tabErrors, structuralProblems } =
    result === undefined ? { tabErrors: [], structuralProblems: [] } : splitRestoreErrors(result);
  // M counts attempted tabs only - see the comment on formatRestoreSummary.
  const total =
    result === undefined ? 0 : result.restored + result.skipped.length + tabErrors.length;
  // Which window, and how fast - both undefined until they would say something true (a
  // single-window restore, or too short a sample to measure).
  const windowLine =
    progress === undefined
      ? undefined
      : formatWindowLine(progress.windowIndex, progress.windowCount);
  const rate =
    progress === undefined ? undefined : formatRate(progress.done, Date.now() - progress.startedAt);
  const pace = joinFacts([windowLine ?? '', rate ?? '']);
  const lazyDone = result === undefined ? undefined : lazyRestoreSummaryHint(result.discarded);

  return (
    <output
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border bg-background p-4 shadow-lg"
    >
      {progress !== undefined && (
        <div className="flex items-center gap-3">
          <LoaderCircle className="size-4 animate-spin" />
          <div className="flex-1 text-sm">
            {tp('restoreProgress', progress.total, formatNumber(progress.done))}
            {pace !== '' && <p className="text-xs text-muted-foreground">{pace}</p>}
            {progress.lazy && (
              <p className="text-xs text-muted-foreground">{t('restoreLazyHint')}</p>
            )}
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{
                  width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`,
                }}
              />
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelling}>
            {cancelling ? t('restoreCancelling') : t('commonCancel')}
          </Button>
        </div>
      )}

      {progress === undefined && result !== undefined && (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-sm">
            <p>{formatRestoreSummary(result, total, { cancelled })}</p>
            {lazyDone !== undefined && (
              <p className="mt-1 text-xs text-muted-foreground">{lazyDone}</p>
            )}
            {(result.skipped.length > 0 ||
              tabErrors.length > 0 ||
              structuralProblems.length > 0) && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs text-muted-foreground">
                {result.skipped.map((url, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- static snapshot, never reordered
                  <li key={`skipped-${i}`} className="truncate" title={url}>
                    {t('restoreSkippedItem', url)}
                  </li>
                ))}
                {tabErrors.map((entry, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- static snapshot, never reordered
                  <li key={`error-${i}`} className="truncate" title={restoreErrorLine(entry)}>
                    {restoreErrorLine(entry)}
                  </li>
                ))}
                {structuralProblems.map((entry, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- static snapshot, never reordered
                  <li key={`structural-${i}`} className="truncate" title={restoreErrorLine(entry)}>
                    {restoreErrorLine(entry)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('restoreDismiss')}
            title={t('restoreDismiss')}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </div>
      )}
    </output>
  );
}
