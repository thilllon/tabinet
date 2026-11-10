import { Ellipsis, ExternalLink, Link, Pencil, Trash2, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { DeleteSessionDialog } from '@/components/delete-session-dialog';
import { ExportMenu } from '@/components/export-menu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { WindowTree } from '@/components/window-tree';
import { useSessionBody } from '@/hooks/use-session-body';
import { useErrorToast } from '@/hooks/use-toast';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { formatDateTime, formatSessionMeta } from '@/lib/display-format';
import { copyText } from '@/lib/download-and-copy';
import { reportError } from '@/lib/error-message';
import { copiedLinkNotice } from '@/lib/export-actions';
import { joinFacts, t } from '@/lib/i18n';
import { isComposingEnter } from '@/lib/ime-composition';
import { openSavedTab } from '@/lib/open-saved-tab';
import { removeTabFromSession, removeWindowFromSession } from '@/lib/session-edit';
import { sessionRepo } from '@/lib/session-repo';
import type { OpenScope } from '@/lib/session-restore';
import type { Session, SessionSummary } from '@/types';

interface SessionDetailProps {
  summary: SessionSummary;
  restoring: boolean;
  onOpen(session: Session, scope: OpenScope): Promise<void>;
  onOpenWindow(session: Session, windowIndex: number, scope: OpenScope): Promise<void>;
  /** "Exported …" / "Copied …" confirmations, shown as a toast by the app. */
  onNotice(message: string): void;
  /** The session is gone; the view must navigate away from its address. */
  onDeleted(): void;
}

/**
 * One saved session, filling the main pane: its name (click to rename), one primary action, and
 * the window → group → tab tree. Everything that is not "open this" lives in the ⋯ menu, so the
 * page has a single obvious button.
 */
export function SessionDetail({
  summary,
  restoring,
  onOpen,
  onOpenWindow,
  onNotice,
  onDeleted,
}: SessionDetailProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useErrorToast(error);
  const body = useSessionBody(summary.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  // Set when Rename is picked in the dropdown and acted on in `onCloseAutoFocus`: the edit must
  // not start while the menu is open, or Radix's focus scope keeps the new Input from getting
  // focus and the trigger refocus blurs it straight back out.
  const renameRequestedRef = useRef(false);
  // Set by Enter/Escape before they close the edit. Chrome fires blur on the input as it leaves
  // the DOM, and React delivers it: without this, that blur would commit again after Enter, or
  // commit the draft Escape just reverted.
  const renameSettledRef = useRef(false);
  const returnFocusRef = useRef(false);

  // A different session in the same pane starts with its own name, not the previous draft.
  useEffect(() => {
    setEditing(false);
    setError(undefined);
    setDraft(summary.name);
  }, [summary.name]);

  const startRename = () => {
    renameSettledRef.current = false;
    setDraft(summary.name);
    setEditing(true);
  };

  // Even mounted after the menu closed, the input can lose the race with a focus handler still
  // unwinding, so claim focus again on the next frame. The caret is parked at the end rather than
  // selecting the name: renaming is usually an edit of the existing name ("Work" → "Work 2").
  useEffect(() => {
    if (!editing) {
      if (returnFocusRef.current) {
        returnFocusRef.current = false;
        nameButtonRef.current?.focus();
      }
      return;
    }
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const commitRename = async () => {
    setEditing(false);
    const name = draft.trim();
    if (name.length === 0 || name === summary.name) {
      return;
    }
    try {
      await sessionRepo.rename(summary.id, name);
      setError(undefined);
    } catch (err) {
      setError(reportError('session', err));
    }
  };

  const handleRenameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      if (isComposingEnter(event)) {
        return;
      }
      event.preventDefault();
      renameSettledRef.current = true;
      returnFocusRef.current = true;
      void commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renameSettledRef.current = true;
      returnFocusRef.current = true;
      setDraft(summary.name);
      setEditing(false);
    }
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    try {
      await sessionRepo.remove(summary.id);
      onDeleted();
    } catch (err) {
      setError(reportError('session', err));
    }
  };

  const handleOpen = async (scope: OpenScope) => {
    setBusy(true);
    try {
      const session = body.session ?? (await sessionRepo.get(summary.id));
      if (session === undefined) {
        setError(t('sessionGone'));
        return;
      }
      setError(undefined);
      await onOpen(session, scope);
    } catch (err) {
      setError(reportError('session', err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenWindow = (windowIndex: number, scope: OpenScope) => {
    if (body.session === undefined) {
      return;
    }
    setError(undefined);
    void onOpenWindow(body.session, windowIndex, scope);
  };

  /**
   * Applies a pure edit (src/lib/session-edit.ts) to the stored body under the lock.
   * `mutate` runs twice on purpose: once here on the loaded body to find out whether the edit
   * would empty the session - that asks for confirmation instead of deleting silently - and once
   * inside `sessionRepo.update`, on the body as it actually is on disk.
   */
  const editSession = async (mutate: (session: Session) => Session | null) => {
    const loaded = body.session;
    if (loaded === undefined) {
      return;
    }
    try {
      if (mutate(loaded) === null) {
        setConfirmingDelete(true);
        return;
      }
      await sessionRepo.update(summary.id, mutate);
      setError(undefined);
    } catch (err) {
      setError(reportError('session', err));
    }
  };

  const handleCopyTabLink = (url: string) => {
    void copyText(url).then((result) => {
      if (result.ok) {
        setError(undefined);
        onNotice(copiedLinkNotice());
        return;
      }
      setError(result.error);
    });
  };

  /** A saved tab that is already open is brought forward instead of opened again. */
  const handleOpenTab = async (url: string): Promise<string | undefined> => {
    const result = await openSavedTab(url);
    if (!result.ok) {
      return result.reason;
    }
    if (result.switched) {
      onNotice(t('sessionSwitchedToOpenTab'));
    }
    return undefined;
  };

  return (
    <section aria-label={summary.name} className="min-w-0">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field appears because the title was just clicked to rename it.
              autoFocus
              ref={inputRef}
              value={draft}
              aria-label={t('sessionNameLabel')}
              title={t('sessionRenameHint')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleRenameKey}
              onBlur={() => {
                if (!renameSettledRef.current) {
                  void commitRename();
                }
              }}
              className="h-9 text-base"
            />
          ) : (
            <div className="flex items-center gap-1">
              <button
                ref={nameButtonRef}
                type="button"
                title={t('sessionRename')}
                onClick={startRename}
                className="min-w-0 truncate rounded-sm text-left text-lg font-semibold outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {summary.name}
              </button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('sessionRenameLabel')}
                title={t('sessionRenameLabel')}
                onClick={startRename}
              >
                <Pencil />
              </Button>
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {joinFacts([
              formatSessionMeta(summary),
              t('sessionSavedAt', formatDateTime(summary.updatedAt)),
            ])}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => void handleOpen('newWindows')}
            disabled={busy || restoring}
            title={t('sessionOpenTitle')}
          >
            <ExternalLink />
            {t('commonOpen')}
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
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (renameRequestedRef.current) {
                  event.preventDefault();
                  renameRequestedRef.current = false;
                  startRename();
                }
              }}
            >
              <DropdownMenuItem
                disabled={busy || restoring}
                onSelect={() => {
                  void handleOpen('here');
                }}
              >
                <ExternalLink />
                {t('sessionOpenHere')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  renameRequestedRef.current = true;
                }}
              >
                <Pencil />
                {t('sessionRename')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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

      <div className="mt-4">
        {body.loading && body.session === undefined && (
          <p className="text-sm text-muted-foreground">{t('commonLoading')}</p>
        )}
        {body.error !== undefined && <p className="text-sm text-destructive">{body.error}</p>}
        {body.session !== undefined && (
          // The ARIA group holding this session's window nodes; no HTML element carries it.
          <div role="tree" aria-label={t('sessionWindowsIn', summary.name)} className="space-y-2">
            {body.session.windows.map((window, index) => (
              <WindowTree
                // oxlint-disable-next-line react/no-array-index-key -- no stable window id
                key={`window-${index}`}
                window={window}
                index={index}
                onOpenTab={(tabIndex) => handleOpenTab(window.tabs[tabIndex].url)}
                actions={
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => handleOpenWindow(index, 'newWindows')}
                      disabled={busy || restoring}
                      title={t('sessionOpenWindowTitle')}
                    >
                      {t('sessionOpenWindow')}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleOpenWindow(index, 'here')}
                      disabled={busy || restoring}
                      title={t('sessionOpenWindowHereTitle')}
                    >
                      {t('sessionOpenWindowHere')}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void editSession((s) => removeWindowFromSession(s, index))}
                      title={t('sessionRemoveWindowTitle')}
                    >
                      <X />
                      {t('sessionRemoveWindow')}
                    </Button>
                    <ExportMenu
                      summary={summary}
                      session={body.session}
                      windowIndex={index}
                      size="icon-xs"
                      onNotice={onNotice}
                      onError={setError}
                    />
                  </>
                }
                renderGroupActions={(groupIndex) => (
                  <ExportMenu
                    summary={summary}
                    session={body.session}
                    windowIndex={index}
                    groupIndex={groupIndex}
                    size="icon-xs"
                    onNotice={onNotice}
                    onError={setError}
                  />
                )}
                renderTabActions={(tabIndex) => (
                  <>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('sessionCopyLink')}
                      title={t('sessionCopyLink')}
                      onClick={() => handleCopyTabLink(window.tabs[tabIndex].url)}
                    >
                      <Link />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('sessionRemoveTab')}
                      title={t('sessionRemoveTab')}
                      onClick={() =>
                        void editSession((s) => removeTabFromSession(s, index, tabIndex))
                      }
                    >
                      <X />
                    </Button>
                  </>
                )}
              />
            ))}
          </div>
        )}
      </div>

      <DeleteSessionDialog
        name={summary.name}
        synced={isCloudSyncEnabled()}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onConfirm={() => void handleDelete()}
      />
    </section>
  );
}
