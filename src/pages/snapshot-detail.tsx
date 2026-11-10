import { BookmarkPlus, Ellipsis, ExternalLink, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { DeleteSessionDialog } from '@/components/delete-session-dialog';
import { ExportMenu } from '@/components/export-menu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WindowTree } from '@/components/window-tree';
import { useSessionBody } from '@/hooks/use-session-body';
import { useErrorToast } from '@/hooks/use-toast';
import { formatDateTime, formatSessionMeta } from '@/lib/display-format';
import { reportError } from '@/lib/error-message';
import { joinFacts, t, tp } from '@/lib/i18n';
import { openSavedTab } from '@/lib/open-saved-tab';
import { historyOriginLabel } from '@/lib/session-list';
import { sessionRepo } from '@/lib/session-repo';
import type { Session, SessionSummary } from '@/types';

/** Stands in for the bold Keep word while the explainer sentence is translated (private use). */
const KEEP_MARKER = '\uE000';

interface SnapshotDetailProps {
  summary: SessionSummary;
  restoring: boolean;
  /** How many snapshots are kept before the oldest unkept one is dropped. */
  keepLast: number;
  onOpen(session: Session): Promise<void>;
  onNotice(message: string): void;
  /** The snapshot became a saved session; its new id is where the view should go. */
  onKept(savedId: string): void;
  onDeleted(): void;
}

/**
 * One automatic snapshot. Two actions only: open it, or keep it - "keep" moves it into the saved
 * list, where pruning never reaches it. Snapshots are not editable: they are a record of what was
 * open, not a document.
 */
export function SnapshotDetail({
  summary,
  restoring,
  keepLast,
  onOpen,
  onNotice,
  onKept,
  onDeleted,
}: SnapshotDetailProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useErrorToast(error);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const body = useSessionBody(summary.id);
  // The bold "Keep" sits inside the translated sentence as $2, wherever the language puts it.
  const [explainerBefore, explainerAfter = ''] = tp(
    'sessionSnapshotExplainer',
    keepLast,
    KEEP_MARKER,
  ).split(KEEP_MARKER);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setError(undefined);
    } catch (err) {
      setError(reportError('snapshot', err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = () =>
    run(async () => {
      const session = body.session ?? (await sessionRepo.get(summary.id));
      if (session === undefined) {
        setError(t('sessionSnapshotGone'));
        return;
      }
      await onOpen(session);
    });

  /** Copy into the saved list, then drop the snapshot: from the user's side it moved. */
  const handleKeep = () =>
    run(async () => {
      const saved = await sessionRepo.duplicateAsSaved(summary.id);
      await sessionRepo.remove(summary.id);
      onNotice(t('sessionKeptNotice', saved.name));
      onKept(saved.id);
    });

  const handleDelete = () => {
    setConfirmingDelete(false);
    void run(async () => {
      await sessionRepo.remove(summary.id);
      onDeleted();
    });
  };

  return (
    <section
      aria-label={t('sessionSnapshotLabel', formatDateTime(summary.createdAt))}
      className="min-w-0"
    >
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold" title={formatDateTime(summary.createdAt)}>
            {formatDateTime(summary.createdAt)}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {joinFacts([historyOriginLabel(summary.origin), formatSessionMeta(summary)])}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void handleOpen()}
            disabled={busy || restoring}
            title={t('sessionSnapshotOpenTitle')}
          >
            <ExternalLink />
            {t('commonOpen')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleKeep()}
            disabled={busy}
            title={t('sessionKeepTitle')}
          >
            <BookmarkPlus />
            {t('sessionKeep')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('sessionMoreActions')}
                title={t('sessionMoreActions')}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                <Trash2 />
                {t('commonDelete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ExportMenu
            summary={summary}
            session={body.session}
            onNotice={onNotice}
            onError={setError}
          />
        </div>
      </header>

      <p className="mt-3 text-xs text-muted-foreground">
        {explainerBefore}
        <strong>{t('sessionKeep')}</strong>
        {explainerAfter}
      </p>

      <div className="mt-4">
        {body.loading && body.session === undefined && (
          <p className="text-sm text-muted-foreground">{t('commonLoading')}</p>
        )}
        {body.error !== undefined && <p className="text-sm text-destructive">{body.error}</p>}
        {body.session !== undefined && (
          // The ARIA group holding this snapshot's window nodes; no HTML element carries it.
          <div role="tree" aria-label={t('sessionSnapshotWindows')} className="space-y-2">
            {body.session.windows.map((window, index) => (
              <WindowTree
                // oxlint-disable-next-line react/no-array-index-key -- no stable window id
                key={`window-${index}`}
                window={window}
                index={index}
                onOpenTab={async (tabIndex) => {
                  const result = await openSavedTab(window.tabs[tabIndex].url);
                  if (!result.ok) {
                    return result.reason;
                  }
                  if (result.switched) {
                    onNotice(t('sessionSwitchedToOpenTab'));
                  }
                  return undefined;
                }}
              />
            ))}
          </div>
        )}
      </div>

      <DeleteSessionDialog
        name={formatDateTime(summary.createdAt)}
        title={t('sessionSnapshotDeleteTitle')}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onConfirm={handleDelete}
      />
    </section>
  );
}
