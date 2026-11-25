import { FileText, Trash2 } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';

import { MemoEditor } from '@/components/memo-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useMemoBody } from '@/hooks/use-memo-body';
import { ToastContext } from '@/hooks/use-toasts';
import { formatDateTime } from '@/lib/display-format';
import { downloadExport } from '@/lib/download-and-copy';
import { reportError } from '@/lib/error-message';
import { exportedNotice } from '@/lib/export-actions';
import { t } from '@/lib/i18n';
import { isMacPlatform } from '@/lib/keyboard-shortcuts';
import { flushMemoEditors, MemoEditorSession, type MemoSaveDone } from '@/lib/memo-editor-state';
import { memoDisplayTitle, memoExport } from '@/lib/memo-export';
import { memoRepo, memoTitle } from '@/lib/memo-repo';
import { ERROR_MS, NOTICE_MS } from '@/lib/toast-queue';
import type { Memo } from '@/types';

const IS_MAC = isMacPlatform(navigator.userAgent);

interface MemoPageProps {
  /** The editor's own id, kept while it follows a copy (its draft key). */
  editorId: string;
  /** The memo the editor writes to now. */
  memoId: string;
  /** Opened from New memo: nothing is stored until the first text. */
  isNew: boolean;
  /** The editor now writes to another memo (its first save, or a copy). */
  onFollow(id: string): void;
  /** The memo was deleted here; the app leaves and offers Undo. */
  onDeleted(memo: Memo): void;
  /** The memo is not there (deleted elsewhere, or a stale address): the view leaves. */
  onGone(): void;
  onNotice(message: string): void;
  /** A save failed while the editor was closing: the app offers the text to copy. */
  onLeftUnsaved(text: string): void;
}

/**
 * One memo (spec 12.1): its title (the first line), when it changed, the text box, Export
 * Markdown and Delete (Undo in a toast, no confirmation). A copy kept from a conflict carries a
 * badge and one line saying so. A body this build cannot read is shown as that, never as an empty
 * box that could be typed over.
 */
export function MemoPage({
  editorId,
  memoId,
  isNew,
  onFollow,
  onDeleted,
  onGone,
  onNotice,
  onLeftUnsaved,
}: MemoPageProps) {
  const body = useMemoBody(memoId);
  const show = useContext(ToastContext);
  const [session, setSession] = useState<MemoEditorSession | null>(null);
  const [initialText, setInitialText] = useState('');
  const [busy, setBusy] = useState(false);
  const goneSent = useRef(false);

  // The editor starts once the memo was read, and then stays: following a copy changes `memoId`
  // under it, never the box.
  useEffect(() => {
    if (session !== null) {
      return;
    }
    if (body.state === 'live') {
      setInitialText(body.memo.text);
      setSession(new MemoEditorSession(memoId, body.memo.text));
    } else if (body.state === 'none') {
      if (isNew) {
        setSession(new MemoEditorSession(memoId, null));
      } else if (!goneSent.current) {
        goneSent.current = true;
        onGone();
      }
    }
  }, [body, session, memoId, isNew, onGone]);

  const current = session !== null && body.id === session.memoId ? body : undefined;
  const memo = current?.state === 'live' ? current.memo : undefined;
  const stored =
    current === undefined || current.state === 'loading' || current.state === 'unreadable'
      ? undefined
      : current.state === 'live'
        ? current.memo.text
        : null;

  const onSaved = (done: MemoSaveDone) => {
    if (done.memo.id !== memoId) {
      onFollow(done.memo.id);
    }
    if (done.outcome === 'copied' || done.outcome === 'redirected') {
      show(t('memoConflictNotice'), { ms: NOTICE_MS, plain: true, key: 'memo-conflict' });
    }
  };

  const onSaveFailed = (err: unknown, text: string, leaving: boolean) => {
    reportError('memo save', err);
    if (leaving) {
      onLeftUnsaved(text);
      return;
    }
    show(t('memoSaveFailed'), { ms: ERROR_MS, tone: 'error', key: 'memo-save-failed' });
  };

  const exportMarkdown = async () => {
    setBusy(true);
    try {
      await flushMemoEditors();
      const saved = await memoRepo.get(session?.memoId ?? memoId);
      if (saved !== null && saved !== 'unreadable') {
        const { base, text } = memoExport(saved);
        downloadExport(base, 'markdown', text);
        onNotice(exportedNotice(base, 'markdown'));
      }
    } catch (err) {
      show(reportError('memo export', err), { ms: ERROR_MS, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await flushMemoEditors();
      const removed = await memoRepo.remove(session?.memoId ?? memoId);
      if (removed !== undefined) {
        onDeleted(removed);
      }
    } catch (err) {
      show(reportError('memo delete', err), { ms: ERROR_MS, tone: 'error' });
      setBusy(false);
    }
  };

  if (body.state === 'unreadable' && session === null) {
    return (
      <section aria-label={t('memoUntitled')} className="min-w-0">
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {t('memoUnreadable')}
        </p>
      </section>
    );
  }
  if (session === null) {
    return <p className="text-sm text-muted-foreground">{t('commonLoading')}</p>;
  }

  const title = memo === undefined ? t('memoNew') : memoDisplayTitle(memoTitle(memo.text));
  return (
    <section aria-label={title} className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="line-clamp-2 text-lg font-semibold break-words" title={title}>
            {title}
          </h1>
          <p className="mt-1 flex min-h-5 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {memo !== undefined && t('memoUpdatedAt', formatDateTime(memo.updatedAt))}
            {memo?.conflictOf !== undefined && (
              <Badge variant="secondary" title={t('memoConflictTitle')}>
                {t('memoConflictBadge')}
              </Badge>
            )}
          </p>
        </div>
        {memo !== undefined && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={busy}
              title={t('memoExportTitle')}
              onClick={() => void exportMarkdown()}
            >
              <FileText />
              {t('memoExport')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              title={t('memoDeleteTitle')}
              onClick={() => void remove()}
            >
              <Trash2 />
              {t('memoDelete')}
            </Button>
          </div>
        )}
      </header>
      {memo?.conflictOf !== undefined && (
        <p className="mt-3 text-xs text-muted-foreground">{t('memoConflictHint')}</p>
      )}
      <div className="mt-4 flex flex-col">
        <MemoEditor
          editorId={editorId}
          session={session}
          initialText={initialText}
          stored={stored}
          isMac={IS_MAC}
          onSaved={onSaved}
          onSaveFailed={onSaveFailed}
          onGone={onGone}
        />
      </div>
    </section>
  );
}
