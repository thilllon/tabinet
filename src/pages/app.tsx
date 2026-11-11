import { Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DialogCloseButton } from '@/components/dialog-close-button';
import { ImportDialog } from '@/components/import-dialog';
import { ProgressToast } from '@/components/progress-toast';
import { QuotaNotice } from '@/components/quota-notice';
import { type PendingRestore, RestoreConfirmDialog } from '@/components/restore-confirm-dialog';
import { SavedToasts } from '@/components/saved-toasts';
import { SearchBar } from '@/components/search-bar';
import { SearchResults } from '@/components/search-results';
import { SidebarNav } from '@/components/sidebar-nav';
import { SidebarResizer } from '@/components/sidebar-resizer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { UnreadableSessionRow } from '@/components/unreadable-session-row';
import { useNotesIndex } from '@/hooks/use-notes-index';
import { useNotesSearchEntries } from '@/hooks/use-notes-search-entries';
import { useOpenWindows } from '@/hooks/use-open-windows';
import { useRestore } from '@/hooks/use-restore';
import { useRoute } from '@/hooks/use-route';
import { useSearchCorpus } from '@/hooks/use-search-corpus';
import { useSessionIndex } from '@/hooks/use-session-index';
import { useSessionSettings } from '@/hooks/use-session-settings';
import { ToastContext, useErrorToast, useSavedToasts } from '@/hooks/use-toasts';
import { formatRoute, HOME, type Route, routeSessionId } from '@/lib/app-route';
import { assembleOutcome, assembleTabs } from '@/lib/assemble-tabs';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { syncNow } from '@/lib/cloud-sync';
import { downloadExport } from '@/lib/download-and-copy';
import { isQuotaError, reportError } from '@/lib/error-message';
import {
  type CollectProgress,
  collectProgressNotice,
  collectSessionBodies,
  canExportAll,
  exportAllNotice,
  shouldReportProgress,
  shouldTickProgress,
} from '@/lib/export-actions';
import { t } from '@/lib/i18n';
import { importedNotice } from '@/lib/import-preview';
import { isMacPlatform, openShortcutSettings, takeShortcutPrompt } from '@/lib/keyboard-shortcuts';
import { openNotesPanel } from '@/lib/open-notes-panel';
import { needsRestoreConfirm } from '@/lib/restore-messages';
import { browserHandlesClick } from '@/lib/row-link';
import { DEFAULT_LIMIT_PER_SOURCE, search } from '@/lib/search-engine';
import {
  buildSearchGroups,
  flattenSearchItems,
  NO_HIGHLIGHT,
  nextIndex,
  prevIndex,
  resolveActivation,
  type SearchItem,
  sessionNameMatches,
} from '@/lib/search-nav';
import {
  type CaptureScope,
  captureSessionWithTabIds,
  nothingToSaveNotice,
} from '@/lib/session-capture';
import { pickWindow } from '@/lib/session-edit';
import { toJson } from '@/lib/session-export';
import { recoveredSnapshot, splitByKind } from '@/lib/session-list';
import { ensureUniqueName } from '@/lib/session-naming';
import { sessionRepo } from '@/lib/session-repo';
import type { OpenScope, RestoreTarget } from '@/lib/session-restore';
import { ACTION_MS, NOTICE_MS } from '@/lib/toast-queue';
import { readSidebarWidth, writeSidebarWidth } from '@/lib/ui-state';
import { currentWindowTarget, goToTab, openTabInBackground } from '@/lib/window-actions';
import { NotesPage } from '@/pages/notes';
import { OpenTabsPage } from '@/pages/open-tabs';
import { SessionPage } from '@/pages/session';
import { SettingsPage } from '@/pages/settings';
import { SnapshotPage } from '@/pages/snapshot';
import type { Session, SessionSettings } from '@/types';

const NEW_WINDOWS: RestoreTarget = { kind: 'newWindows' };

/** Shown beside the name in the header; the manifest's version is package.json's. */
const VERSION = chrome.runtime.getManifest().version;

/** The running count and the final line of "Export everything" are one toast that changes. */
const EXPORT_ALL_TOAST = 'export-all';

/**
 * Tabinet's one page: the sidebar lists what you have, the main pane shows what you picked,
 * and Settings is a dialog over it rather than a second page - still an address of its own
 * (Chrome's "Options" opens `app.html#settings`), drawn on top of the view you were in.
 * Everything below is wiring - the session logic lives in `src/lib/`
 * and the reusable pieces in `src/components/` and `src/hooks/`.
 */
export function App() {
  // `route` is the address; `page` is what the panes show, which differs only while Settings is
  // open over them.
  const { route, page, navigate, closeSettings, resetPage } = useRoute();
  const settingsOpen = route.view === 'settings';
  // What had focus when Settings opened. The dialog is opened by the route, not by a
  // `DialogTrigger`, so Radix has nothing to hand focus back to on close.
  const settingsOpener = useRef<Element | null>(null);

  // Cloud sync runs once when the page opens (a no-op unless configured and ready); the result is
  // in Settings > Account, and the session list follows whatever it changed through its listener.
  useEffect(() => {
    if (isCloudSyncEnabled()) {
      syncNow().catch((err: unknown) => reportError('sync on open failed', err));
    }
  }, []);

  // The page header's height, for whatever sticks right under it (the Open tabs selection bar).
  // Measured rather than assumed: the header wraps to a second row on a narrow window.
  const pageHeader = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = pageHeader.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const publish = () => {
      document.documentElement.style.setProperty('--app-header-h', `${element.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Dragged by the handle between the columns, kept in localStorage (see ui-state.ts).
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const { sessions, loading, error: indexError } = useSessionIndex();
  const openWindows = useOpenWindows();
  const sessionSettings = useSessionSettings();
  const { restore, progress, running, cancel, cancelling, lastResult, cancelled, dismiss } =
    useRestore();
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Notices ("Exported …", "Saved …") are toasts, not a line above the content: a line pushes the
  // whole pane down when it appears and back up when it goes, which reads as the page shaking.
  const { toasts, show, dismiss: dismissToast } = useSavedToasts();
  const setNotice = useCallback(
    (message: string, key?: string) => show(message, { ms: NOTICE_MS, plain: true, key }),
    [show],
  );
  const [error, setError] = useState<string | undefined>(undefined);

  // Once per command: a suggested key Chrome left unbound (it binds them on a fresh install only).
  useEffect(() => {
    takeShortcutPrompt(isMacPlatform(navigator.userAgent)).then(
      (message) => {
        if (message !== undefined) {
          show(message, {
            ms: ACTION_MS,
            plain: true,
            action: { label: t('shortcutPromptButton'), run: () => void openShortcutSettings() },
          });
        }
      },
      (err: unknown) => console.warn('[tabinet] shortcut prompt:', err),
    );
  }, [show]);
  // A write that failed on the storage quota: one fixed sentence plus a way to the meter, rather
  // than Chrome's "Resource::kQuotaBytes quota exceeded" in the error banner.
  const [quotaFull, setQuotaFull] = useState(false);
  const [pending, setPending] = useState<PendingRestore | undefined>(undefined);

  // Search. `query` is the debounced value SearchBar commits; the typed text never
  // reaches this component, so a keystroke re-renders nothing but the box itself. `searchEpoch`
  // remounts (and so clears) the box when a sidebar click leaves the search view.
  const query = page.view === 'search' ? page.query : '';
  const searching = query !== '';
  const [searchEpoch, setSearchEpoch] = useState(0);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [limitPerSource, setLimitPerSource] = useState(DEFAULT_LIMIT_PER_SOURCE);
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);
  const [pendingActivation, setPendingActivation] = useState<string | undefined>(undefined);
  const {
    corpus: tabCorpus,
    warming,
    ensureLoaded,
  } = useSearchCorpus({
    summaries: sessions,
    openWindows,
  });
  const { notes: noteVideos, loading: notesLoading, error: notesError } = useNotesIndex();
  const noteEntries = useNotesSearchEntries(noteVideos);
  const corpus = useMemo(() => [...tabCorpus, ...noteEntries], [tabCorpus, noteEntries]);

  const { saved, history } = useMemo(() => splitByKind(sessions), [sessions]);
  const recovered = recoveredSnapshot(history);
  const busy = saving || running;

  const announce = (message: string) => {
    setError(undefined);
    setQuotaFull(false);
    setNotice(message);
  };

  /** Every failed *write*: a full disk becomes the quota notice, everything else a plain error. */
  const reportWriteError = (err: unknown) => {
    if (isQuotaError(err)) {
      setError(undefined);
      setQuotaFull(true);
      return;
    }
    setError(reportError('app', err));
  };

  const go = (next: Route) => {
    setError(undefined);
    // Settings opens over the results, so the box keeps its text; any other view replaces them.
    if (next.view !== 'search' && next.view !== 'settings' && searching) {
      setSearchEpoch((epoch) => epoch + 1);
    }
    navigate(next);
  };

  /**
   * Resolves with the ids of the tabs that are now stored, or undefined when nothing was saved -
   * the selection's "Save & close" closes those tabs and no others.
   */
  const save = async (scope: CaptureScope): Promise<number[] | undefined> => {
    setSaving(true);
    setError(undefined);
    setQuotaFull(false);
    try {
      const { session, tabIds } = await captureSessionWithTabIds(scope);
      if (session.windows.length === 0) {
        setNotice(nothingToSaveNotice(scope));
        return undefined;
      }
      // Two saves in the same minute would otherwise share the default name.
      const names = (await sessionRepo.listSummaries()).map((summary) => summary.name);
      const named: Session = { ...session, name: ensureUniqueName(session.name, names) };
      await sessionRepo.put(named);
      setNotice(t('appSavedNotice', named.name));
      navigate({ view: 'saved', id: named.id });
      return tabIds;
    } catch (err) {
      reportWriteError(err);
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  // This tab's window, known before any click: the notes panel must be opened straight from the
  // click, and the gesture is safest with nothing awaited before `chrome.sidePanel.open`.
  const ownWindowId = useRef<number | undefined>(undefined);
  useEffect(() => {
    chrome.windows.getCurrent().then(
      (current) => {
        ownWindowId.current = current.id;
      },
      (err: unknown) => console.error('[tabinet] window unknown', err),
    );
  }, []);

  /** The YouTube notes side panel, in this window. */
  const openNotes = () => {
    openNotesPanel(ownWindowId.current).catch((err: unknown) => {
      console.error('[tabinet] notes panel not opened', err);
      setError(t('notesOpenFailed'));
    });
  };

  /**
   * The icon menu's "Assemble!", run from the page. `assembleTabs()` is nothing but `chrome.*`
   * calls, so it runs here as it does in the worker; the window it gathers into is the
   * last-focused one, which is this one, since the click just happened in it.
   */
  const assemble = async () => {
    setAssembling(true);
    setError(undefined);
    try {
      const outcome = assembleOutcome(await assembleTabs());
      if (outcome.kind === 'error') {
        setError(outcome.message);
      } else {
        setNotice(outcome.message);
      }
    } catch (err) {
      setError(reportError('app', err));
    } finally {
      setAssembling(false);
    }
  };

  /** The whole store as one `ExportBundle`, read body by body through `sessionRepo`. */
  const exportAll = async () => {
    setError(undefined);
    setExporting(true);
    try {
      const summaries = await sessionRepo.listSummaries();
      // Settings disables the button while there is nothing to export (canExportAll), so an
      // empty store here is a race with a deletion elsewhere: there is nothing to say.
      if (!canExportAll(summaries)) {
        return;
      }
      const onProgress = shouldReportProgress(summaries.length)
        ? (collected: CollectProgress) => {
            if (shouldTickProgress(collected)) {
              setNotice(collectProgressNotice(collected), EXPORT_ALL_TOAST);
            }
          }
        : undefined;
      const { sessions: bodies, skipped } = await collectSessionBodies(summaries, onProgress);
      if (bodies.length === 0) {
        setNotice(t('expNothingToExportAll'));
        return;
      }
      downloadExport('backup', 'json', toJson(bodies, Date.now()));
      const summary = exportAllNotice(bodies.length, skipped.length);
      if (skipped.length > 0) {
        // An incomplete backup has to stay on screen until it is dealt with; a toast would be
        // gone by the time the download bubble has been looked at.
        setError(summary);
      } else {
        setNotice(summary, EXPORT_ALL_TOAST);
      }
    } catch (err) {
      setError(reportError('app', err));
    } finally {
      setExporting(false);
    }
  };

  const runRestore = async (
    session: Session,
    target: RestoreTarget,
    lazy?: SessionSettings['restoreLazy'],
  ): Promise<void> => {
    try {
      const outcome = await restore(session, target, lazy);
      if (!outcome.ok) {
        setNotice(t('appOpenAlreadyRunning'));
      }
    } catch (err) {
      setError(reportError('app', err));
    }
  };

  const requestOpen = async (
    session: Session,
    scope: OpenScope,
    windowIndex?: number,
  ): Promise<void> => {
    setError(undefined);
    try {
      const target = scope === 'here' ? await currentWindowTarget() : NEW_WINDOWS;
      const scoped = windowIndex === undefined ? session : pickWindow(session, windowIndex);
      if (needsRestoreConfirm(scoped)) {
        const settings = await sessionRepo.getSettings();
        setPending({ session: scoped, target, restoreLazy: settings.restoreLazy });
        return;
      }
      await runRestore(scoped, target);
    } catch (err) {
      setError(reportError('app', err));
    }
  };

  const confirmRestore = (lazy: SessionSettings['restoreLazy']) => {
    if (pending === undefined) {
      return;
    }
    const { session, target } = pending;
    setPending(undefined);
    void runRestore(session, target, lazy);
  };

  const results = useMemo(
    () => search(corpus, query, { limitPerSource, includeHistory }),
    [corpus, query, limitPerSource, includeHistory],
  );
  const sessionMatches = useMemo(
    () => (searching ? sessionNameMatches(sessions, results.tokens, { includeHistory }) : []),
    [searching, sessions, results.tokens, includeHistory],
  );
  const groups = useMemo(
    () => (searching ? buildSearchGroups(results, sessionMatches) : []),
    [searching, results, sessionMatches],
  );
  const items = useMemo(() => flattenSearchItems(groups), [groups]);

  // Tier 2 is lazy: bodies the idle pre-warm did not reach are read on the first query that
  // needs them, and snapshot bodies only once "Also search snapshots" is chosen.
  useEffect(() => {
    if (!searching) {
      return;
    }
    void ensureLoaded(
      sessions
        .filter(
          (summary) =>
            summary.unreadable === undefined && (includeHistory || summary.kind !== 'history'),
        )
        .map((summary) => summary.id),
    );
  }, [searching, includeHistory, sessions, ensureLoaded]);

  const resetResults = () => {
    setHighlight(NO_HIGHLIGHT);
    setLimitPerSource(DEFAULT_LIMIT_PER_SOURCE);
  };

  const activateItem = async (item: SearchItem | undefined): Promise<void> => {
    if (item === undefined) {
      return;
    }
    setError(undefined);
    if (item.kind === 'note') {
      // A note is shown among its video's notes, where its time links to the video.
      if (item.entry.videoId !== undefined) {
        go({ view: 'notes', videoId: item.entry.videoId });
      }
      return;
    }
    if (item.kind === 'session') {
      // A matching session name goes to that session rather than opening 90 tabs on one Enter.
      go({ view: item.summary.kind === 'history' ? 'auto' : 'saved', id: item.summary.id });
      return;
    }
    const { entry } = item;
    const result =
      entry.tabId !== undefined && entry.windowId !== undefined
        ? await goToTab(entry.tabId, entry.windowId)
        : await openTabInBackground(entry.url);
    if (!result.ok) {
      setError(result.reason);
    }
  };

  // Enter is resolved one render *after* the key press: SearchBar commits the query and requests
  // the activation in the same handler, so anything activated inside that handler would come from
  // the previous render's `items`/`highlight`. `resolveActivation` waits for the results that
  // describe the typed text.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose (see above).
  useEffect(() => {
    if (pendingActivation === undefined) {
      return;
    }
    const decision = resolveActivation({
      typedQuery: pendingActivation,
      committedQuery: query,
      highlight,
      itemCount: items.length,
    });
    if (decision.action === 'wait') {
      return;
    }
    setPendingActivation(undefined);
    if (decision.action === 'activate') {
      void activateItem(items[decision.index]);
    }
  });

  const selected = useMemo(() => {
    const id = routeSessionId(page);
    return id === undefined ? undefined : sessions.find((summary) => summary.id === id);
  }, [page, sessions]);

  const selectedNotes = useMemo(
    () =>
      page.view === 'notes'
        ? noteVideos.find((summary) => summary.videoId === page.videoId)
        : undefined,
    [page, noteVideos],
  );

  // A session deleted in another tab (or by the snapshot ring) leaves its address pointing at
  // nothing; fall back to the list rather than showing an empty pane. The same for a video whose
  // last note was deleted (here, or in the side panel).
  useEffect(() => {
    const gone =
      (!loading && selected === undefined && (page.view === 'saved' || page.view === 'auto')) ||
      (!notesLoading && selectedNotes === undefined && page.view === 'notes');
    if (gone) {
      if (settingsOpen) {
        // Deleted from inside Settings ("Delete all data"): the dialog stays, the pane behind it
        // changes. Navigating would close the dialog under the user's hands.
        resetPage(HOME);
        return;
      }
      navigate(HOME, true);
    }
  }, [loading, selected, notesLoading, selectedNotes, page, settingsOpen, navigate, resetPage]);

  const main = () => {
    if (searching) {
      const found = results.total + sessionMatches.length;
      return (
        <>
          {found === 0 && !includeHistory && (
            <div className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              {t('appSearchNothingFound')}
              <Button
                variant="outline"
                size="sm"
                className="ml-3"
                title={t('appSearchHistoryTitle')}
                onClick={() => {
                  setIncludeHistory(true);
                  resetResults();
                }}
              >
                {t('appSearchHistoryButton')}
              </Button>
            </div>
          )}
          <SearchResults
            groups={groups}
            query={query}
            tokens={results.tokens}
            total={results.total + sessionMatches.length}
            highlight={highlight}
            warming={warming}
            onHighlight={setHighlight}
            onActivate={(index) => void activateItem(items[index])}
            onShowMore={() => setLimitPerSource((current) => current + DEFAULT_LIMIT_PER_SOURCE)}
          />
        </>
      );
    }
    if (selected !== undefined && selected.unreadable !== undefined) {
      return (
        <ul className="space-y-2">
          <UnreadableSessionRow
            summary={selected}
            unreadable={selected.unreadable}
            onDeleted={() => navigate(HOME, true)}
          />
        </ul>
      );
    }
    if (page.view === 'saved' && selected !== undefined) {
      return (
        <SessionPage
          key={selected.id}
          summary={selected}
          restoring={running}
          onOpen={(session, scope) => requestOpen(session, scope)}
          onOpenWindow={(session, windowIndex, scope) => requestOpen(session, scope, windowIndex)}
          onNotice={announce}
          onDeleted={() => navigate(HOME, true)}
        />
      );
    }
    if (page.view === 'notes' && selectedNotes !== undefined) {
      return (
        <NotesPage
          key={selectedNotes.videoId}
          summary={selectedNotes}
          onNotice={announce}
          onDeleted={() => navigate(HOME, true)}
        />
      );
    }
    if (page.view === 'auto' && selected !== undefined) {
      return (
        <SnapshotPage
          key={selected.id}
          summary={selected}
          restoring={running}
          keepLast={sessionSettings.settings.historyMaxSnapshots}
          onOpen={(session) => requestOpen(session, 'newWindows')}
          onNotice={announce}
          onKept={(savedId) => navigate({ view: 'saved', id: savedId }, true)}
          onDeleted={() => navigate(HOME, true)}
        />
      );
    }
    return (
      <OpenTabsPage
        openWindows={openWindows}
        busy={busy}
        savedCount={saved.length}
        onSaveAll={() => void save('all')}
        onAssemble={() => void assemble()}
        assembling={assembling}
        onOpenNotes={openNotes}
        onSaveWindow={(windowId) => void save({ windowId })}
        onSaveTabs={(tabIds) => save({ tabIds })}
        onOpenSettings={() => go({ view: 'settings' })}
        onNotice={announce}
        onError={setError}
      />
    );
  };

  // Every alert is a toast (owner's rule): an error is a red one that stays up for ERROR_MS. Only
  // the quota notice keeps a line, because it carries a way to the storage meter.
  useErrorToast(error, show);
  useErrorToast(indexError, show);
  useErrorToast(notesError, show);
  const banners = (
    <>{quotaFull && <QuotaNotice onShowStorage={() => go({ view: 'settings' })} />}</>
  );

  // One stack for the whole page, drawn inside the Settings dialog while that is open for the
  // same reason as the progress toast below.
  const toastStack = <SavedToasts toasts={toasts} onDismiss={dismissToast} />;

  const progressToast = (
    <ProgressToast
      progress={progress}
      result={lastResult}
      cancelling={cancelling}
      cancelled={cancelled}
      onCancel={cancel}
      onDismiss={dismiss}
    />
  );

  return (
    <ToastContext.Provider value={show}>
      <div className="min-h-screen bg-muted/30">
        <header
          ref={pageHeader}
          className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background px-4 py-2"
        >
          {/* The wordmark is the way back to the open tabs, so it is a link to that route rather
            than a button that happens to navigate. */}
          <a
            href={formatRoute(HOME)}
            onClick={(event) => {
              if (browserHandlesClick(event)) {
                return;
              }
              event.preventDefault();
              go(HOME);
            }}
            title={t('appHomeTitle')}
            className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <img src="/img/logo-32.png" alt="" aria-hidden="true" className="size-5 rounded" />
            {t('appName')}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              v{VERSION}
            </span>
          </a>
          <div className="mx-auto flex max-w-xl flex-1 justify-center">
            <SearchBar
              key={searchEpoch}
              onQueryChange={(next) => {
                if (next === query) {
                  return;
                }
                resetResults();
                navigate(next === '' ? HOME : { view: 'search', query: next }, true);
              }}
              onMove={(direction) =>
                setHighlight((current) =>
                  direction === 'next'
                    ? nextIndex(current, items.length)
                    : prevIndex(current, items.length),
                )
              }
              onActivate={setPendingActivation}
            />
          </div>
          {/* `asChild` renders the Button's styling onto the anchor, so this gains an address without
            src/components/ui/button.tsx being touched: Settings opens as a dialog, yet it is still
            a link to `#settings` that a middle-click opens in a tab of its own. */}
          <Button asChild variant="outline" size="sm">
            <a
              href={formatRoute({ view: 'settings' })}
              title={t('commonOpenSettingsTitle')}
              onClick={(event) => {
                if (browserHandlesClick(event)) {
                  return;
                }
                event.preventDefault();
                go({ view: 'settings' });
              }}
            >
              <Settings />
              {t('appSettings')}
            </a>
          </Button>
        </header>

        <div
          className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[var(--sidebar-width)_10px_minmax(0,1fr)]"
          style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
        >
          {/* A panel, not a bare column: the sidebar and the main pane hold different kinds of
            thing, and a surface of its own says so without a word of explanation. */}
          <aside className="min-w-0 rounded-lg border bg-card p-2 lg:sticky lg:top-16 lg:self-start">
            <SidebarNav
              route={page}
              saved={saved}
              history={history}
              notes={noteVideos}
              notesLoading={notesLoading}
              windowCount={openWindows.windows.length}
              tabCount={openWindows.windows.reduce((count, win) => count + win.tabs.length, 0)}
              recoveredId={recovered?.id}
              loading={loading}
              onNavigate={go}
            />
          </aside>

          <SidebarResizer
            width={sidebarWidth}
            onResize={setSidebarWidth}
            onCommit={writeSidebarWidth}
          />

          <main className="min-w-0 space-y-3">
            {!settingsOpen && banners}
            {main()}
          </main>
        </div>

        {/* Settings: an address (`#settings`) drawn as a dialog over the view behind it. Closing it
 - Escape, the ×, a click outside - leaves that address. The width and the scrolling body
          are set here by class, not in src/components/ui/dialog.tsx. */}
        <Dialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (open) {
              return;
            }
            // A field that writes on blur (a snapshot interval or limit) would otherwise be unmounted
            // with its text unsaved: Escape closes the dialog without moving focus first.
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
            closeSettings(page);
          }}
        >
          {/* The max-width keeps the stock 1rem side margins on a narrow window, which a bare
            `sm:max-w-3xl` would drop between 640 and 800px. */}
          <DialogContent
            showCloseButton={false}
            className="flex max-h-[calc(100dvh-4rem)] flex-col gap-0 p-0 sm:max-w-[min(48rem,calc(100%-2rem))]"
            onOpenAutoFocus={() => {
              settingsOpener.current = document.activeElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (settingsOpener.current instanceof HTMLElement) {
                settingsOpener.current.focus();
              }
            }}
          >
            <SettingsPage
              summaries={sessions}
              onNotice={announce}
              onSaved={show}
              onError={setError}
              onExportAll={() => void exportAll()}
              onImport={() => setImportOpen(true)}
              exporting={exporting}
              focus={route.view === 'settings' ? route.focus : undefined}
            >
              {banners}
            </SettingsPage>
            {/* Inside the dialog while it is open: left in the page it would sit under the overlay,
              dimmed, hidden from screen readers, and its Cancel would count as a click outside. */}
            {progressToast}
            {toastStack}
            <DialogCloseButton />
          </DialogContent>
        </Dialog>

        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={(count) => announce(importedNotice(count))}
        />
        <RestoreConfirmDialog
          pending={pending}
          onConfirm={confirmRestore}
          onCancel={() => setPending(undefined)}
        />
        {!settingsOpen && progressToast}
        {!settingsOpen && toastStack}
      </div>
    </ToastContext.Provider>
  );
}
