import { Combine, Keyboard, NotebookPen, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { CloseTabsDialog } from '@/components/close-tabs-dialog';
import { OpenWindowsPane } from '@/components/open-windows-pane';
import { SelectionBar } from '@/components/selection-bar';
import { Button } from '@/components/ui/button';
import type { OpenWindowsState } from '@/hooks/use-open-windows';
import { copyText } from '@/lib/download-and-copy';
import { t, tp } from '@/lib/i18n';
import type { OpenWindowView } from '@/lib/open-windows';
import {
  type CopyFormat,
  closedTabsNotice,
  copiedSelectionNotice,
  EMPTY_SELECTION,
  keptOpenNotice,
  pruneSelection,
  selectBySite,
  selectedTabs,
  selectionText,
  selectRange,
  type TabSelection,
  toggleSelected,
  toggleWindow,
} from '@/lib/tab-selection';
import { closeTabs } from '@/lib/window-actions';

interface OpenTabsPageProps {
  openWindows: OpenWindowsState;
  busy: boolean;
  /** How many sessions are already saved: the first-run hint only shows while there are none. */
  savedCount: number;
  onSaveAll(): void;
  /** Moves every other window's tabs into this one - the icon menu's "Assemble!". */
  onAssemble(): void;
  /** An assemble run is under way. */
  assembling: boolean;
  /** Opens the YouTube notes side panel in this window. */
  onOpenNotes(): void;
  onSaveWindow(windowId: number): void;
  /**
   * Saves these live tabs as a session. Resolves with the ids of the tabs that were stored -
   * fewer than asked for when one closed or stopped being saveable in the meantime - or undefined
   * when nothing was saved.
   */
  onSaveTabs(tabIds: number[]): Promise<number[] | undefined>;
  onOpenSettings(): void;
  /** "Copied …" / "Closed …" - a toast, shown by the app. */
  onNotice(message: string): void;
  onError(message: string): void;
}

/**
 * The default view: what is open right now, and one button that saves it. The button says what it
 * will take - "Save all windows" is a different promise from "Save this window", and the user
 * should not have to count their windows to know which one they are pressing. Saving a single
 * window stays on that window's row, where it belongs. With more than one window open, a second
 * button gathers them all into this one.
 *
 * Ticking tabs in the list turns the heading into a bar that acts on just those: save, copy,
 * close. The bar takes the heading's place rather than a line of its own, so the list underneath
 * does not jump when the first box is ticked, and it sticks below the page header so it is still
 * there after scrolling down a long window to tick more.
 */
export function OpenTabsPage({
  openWindows,
  busy,
  savedCount,
  onSaveAll,
  onAssemble,
  assembling,
  onOpenNotes,
  onSaveWindow,
  onSaveTabs,
  onOpenSettings,
  onNotice,
  onError,
}: OpenTabsPageProps) {
  const [selection, setSelection] = useState<TabSelection>(EMPTY_SELECTION);
  // The tab ticked last: where a shift-click's range starts.
  const anchor = useRef<number | undefined>(undefined);

  // A ticked tab that closes (here or in the browser) leaves the selection with it.
  useEffect(() => {
    setSelection((current) => pruneSelection(openWindows.windows, current));
  }, [openWindows.windows]);

  const chosen = selectedTabs(openWindows.windows, selection);
  const chosenIds = chosen.map((tab) => tab.tabId);
  const selecting = chosen.length > 0;
  const [confirmingClose, setConfirmingClose] = useState(false);

  // The bar holds the buttons that empty the selection, and it goes when the selection does.
  // Focus would fall back to <body>; it is handed to the heading that takes the bar's place.
  const heading = useRef<HTMLHeadingElement>(null);
  const wasSelecting = useRef(false);
  useEffect(() => {
    if (wasSelecting.current && !selecting) {
      heading.current?.focus();
    }
    wasSelecting.current = selecting;
  }, [selecting]);

  const toggleTab = (tabId: number, shiftKey: boolean) => {
    // Read now, not inside the updater: React may run the updater later, during render, and by
    // then the anchor below has already moved to this very tab - a range of one.
    const from = anchor.current;
    anchor.current = tabId;
    setSelection((current) =>
      shiftKey
        ? selectRange(openWindows.windows, current, from, tabId)
        : toggleSelected(current, tabId),
    );
  };

  // A window's select-all box. The anchor is dropped: a shift-click after it starts afresh.
  const toggleWholeWindow = (window: OpenWindowView) => {
    anchor.current = undefined;
    setSelection((current) => toggleWindow(window, current));
  };

  const clearSelection = () => {
    setSelection(EMPTY_SELECTION);
    anchor.current = undefined;
  };

  const copy = (format: CopyFormat) => {
    void copyText(selectionText(chosen, format)).then((result) => {
      if (result.ok) {
        onNotice(copiedSelectionNotice(chosen.length, format));
      } else {
        onError(result.error);
      }
    });
  };

  const close = async (tabIds: number[] = chosenIds) => {
    const result = await closeTabs(tabIds);
    if (result.ok) {
      onNotice(closedTabsNotice(tabIds.length));
    } else {
      onError(result.reason);
    }
  };

  const saveAndClose = async () => {
    const asked = chosenIds;
    // Close only what was really stored. The save reads the browser afresh, so it can hold fewer
    // tabs than were ticked; a tab that did not make it into the session stays open.
    const stored = await onSaveTabs(asked);
    if (stored === undefined) {
      return;
    }
    const wanted = new Set(asked);
    const safe = stored.filter((tabId) => wanted.has(tabId));
    await close(safe);
    if (safe.length < asked.length) {
      onNotice(keptOpenNotice(asked.length - safe.length));
    }
  };

  const windowCount = openWindows.windows.length;
  const tabCount = openWindows.windows.reduce((count, win) => count + win.tabs.length, 0);
  const saveLabel = windowCount > 1 ? t('openSaveAllWindows') : t('openSaveThisWindow');

  return (
    <section aria-label={t('openHeading')} className="min-w-0">
      {selecting ? (
        // `--app-header-h` is the page header's measured height (app.tsx), so the bar sits flush
        // under it whatever that header wraps to.
        <header className="sticky top-[var(--app-header-h,4rem)] z-[5] -my-2 flex min-h-16 flex-wrap items-center gap-2 bg-background py-2">
          <SelectionBar
            count={chosen.length}
            busy={busy}
            onClear={clearSelection}
            onSave={() => void onSaveTabs(chosenIds)}
            onSaveAndClose={() => void saveAndClose()}
            onCopy={copy}
            onClose={() => (chosen.length > 1 ? setConfirmingClose(true) : void close())}
            onSelectBySite={(mode) =>
              setSelection((current) => selectBySite(openWindows.windows, current, mode))
            }
          />
        </header>
      ) : (
        <header className="-my-2 flex min-h-16 flex-wrap items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('openHeading')}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('commonWindowsAndTabs', tp('windowCount', windowCount), tp('tabCount', tabCount))}
            </p>
          </div>
          {/* Only where there is something to gather. Same name as the icon's right-click item, so
            the two are recognisably one action; that item spells the explanation out in brackets,
            here it is the tooltip. */}
          {windowCount > 1 && (
            <Button
              variant="outline"
              onClick={onAssemble}
              disabled={busy || assembling}
              title={t('cmdAssembleTabs')}
            >
              <Combine />
              {t('assembleName')}
            </Button>
          )}
          <Button variant="outline" onClick={onOpenNotes} title={t('notesOpenTitle')}>
            <NotebookPen />
            {t('cmdOpenNotes')}
          </Button>
          <Button
            onClick={onSaveAll}
            disabled={busy || windowCount === 0}
            title={windowCount > 1 ? t('openSaveAllWindowsTitle') : t('openSaveWindowTitle')}
          >
            <Save />
            {saveLabel}
          </Button>
        </header>
      )}

      {savedCount === 0 && (
        <p className="mt-4 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {/* One sentence per language, with the bold names and the link dropped in where that
            language puts them: the message carries {1} {2} {3} markers that are split out here. */}
          {t('openFirstRunHint', '{1}', '{2}', '{3}')
            .split(/(\{[123]\})/)
            .map((part, index) => {
              switch (part) {
                case '{1}':
                  return <strong key="save">{saveLabel}</strong>;
                case '{2}':
                  return <strong key="menu">{t('workerMenuSaveAll')}</strong>;
                case '{3}':
                  return (
                    <button
                      key="settings"
                      type="button"
                      onClick={onOpenSettings}
                      title={t('commonOpenSettingsTitle')}
                      className="inline-flex items-center gap-1 rounded-sm underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <Keyboard className="size-3.5" />
                      {t('openFirstRunHintSettingsLink')}
                    </button>
                  );
                default:
                  // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed sentence never reorder
                  return <span key={index}>{part}</span>;
              }
            })}
        </p>
      )}

      <div className="mt-4">
        <OpenWindowsPane
          windows={openWindows.windows}
          currentWindowId={openWindows.currentWindowId}
          loading={openWindows.loading}
          error={openWindows.error}
          onSaveWindow={onSaveWindow}
          busy={busy}
          selection={selection}
          onToggleTab={toggleTab}
          onToggleWindow={toggleWholeWindow}
        />
      </div>

      <CloseTabsDialog
        tabCount={chosen.length}
        open={confirmingClose && selecting}
        onOpenChange={setConfirmingClose}
        onConfirm={() => {
          setConfirmingClose(false);
          void close();
        }}
      />
    </section>
  );
}
