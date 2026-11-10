import { AppWindow, Save, SquareArrowOutUpRight, X } from 'lucide-react';
import { useState } from 'react';

import { CloseWindowDialog } from '@/components/close-window-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WindowSelectAll } from '@/components/window-select-all';
import { WindowTree } from '@/components/window-tree';
import { useErrorToast } from '@/hooks/use-toast';
import { formatNumber, t } from '@/lib/i18n';
import type { OpenWindowView } from '@/lib/open-windows';
import { selectionState, type TabSelection } from '@/lib/tab-selection';
import { closeTab, closeWindow, goToTab } from '@/lib/window-actions';

interface OpenWindowsPaneProps {
  windows: OpenWindowView[];
  /** The window this dashboard tab is in; it gets the "This window" marker. */
  currentWindowId?: number;
  loading: boolean;
  error?: string;
  /** Saves that live window as a session; the app owns the notice toasts and the error lines. */
  onSaveWindow(windowId: number): void;
  /** Disables the save buttons while a save or a restore is running. */
  busy: boolean;
  /** The ticked tabs, by tab id; every row gets a tick box that `onToggleTab` flips. */
  selection: TabSelection;
  onToggleTab(tabId: number, shiftKey: boolean): void;
  /** A window's select-all box: ticks every tab of that window, or clears them. */
  onToggleWindow(window: OpenWindowView): void;
}

interface PendingClose {
  windowId: number;
  windowNumber: number;
  tabCount: number;
  isCurrent: boolean;
}

/**
 * Live list of the open windows, as the same window → group → tab tree the saved sessions use
 * (`WindowTree`), plus the actions that only make sense on a live window. Every chrome call goes
 * through `window-actions.ts`; the pane never touches the service worker.
 */
export function OpenWindowsPane({
  windows,
  currentWindowId,
  loading,
  error,
  onSaveWindow,
  busy,
  selection,
  onToggleTab,
  onToggleWindow,
}: OpenWindowsPaneProps) {
  const [pendingClose, setPendingClose] = useState<PendingClose | undefined>(undefined);
  // Radix keeps the dialog mounted through its close animation; the last pending value keeps its
  // text from flashing empty while it fades out.
  const [lastClose, setLastClose] = useState<PendingClose | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  useErrorToast(error);
  useErrorToast(actionError);

  const requestClose = (pending: PendingClose) => {
    setActionError(undefined);
    setPendingClose(pending);
    setLastClose(pending);
  };

  const confirmClose = () => {
    const pending = pendingClose;
    setPendingClose(undefined);
    if (pending === undefined) {
      return;
    }
    void closeWindow(pending.windowId).then((result) => {
      setActionError(result.ok ? undefined : result.reason);
    });
  };

  const removeTab = (tabId: number) => {
    void closeTab(tabId).then((result) => {
      setActionError(result.ok ? undefined : result.reason);
    });
  };

  const activateTab = (tabId: number, windowId: number) => {
    void goToTab(tabId, windowId).then((result) => {
      setActionError(result.ok ? undefined : result.reason);
    });
  };

  const shown = pendingClose ?? lastClose;

  return (
    <section aria-labelledby="open-windows-heading" className="min-w-0">
      {/* The surrounding view already says "Open tabs" above it; the heading names the tree. */}
      <div className="sr-only">
        <h2 id="open-windows-heading" className="text-sm font-semibold">
          {t('openWindowsHeading')}
        </h2>
        <span className="text-xs text-muted-foreground">{formatNumber(windows.length)}</span>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('commonLoading')}</p>
      ) : windows.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <AppWindow className="size-4" />
          {t('openNoWindows')}
        </p>
      ) : (
        // The live windows are a tree too: window -> group -> tab.
        <div role="tree" aria-labelledby="open-windows-heading" className="mt-3 space-y-2">
          {windows.map((window, index) => (
            <WindowTree
              key={window.windowId}
              window={window}
              index={index}
              subheader={
                <WindowSelectAll
                  windowNumber={formatNumber(index + 1)}
                  state={selectionState(window, selection)}
                  onToggle={() => onToggleWindow(window)}
                />
              }
              badge={
                window.windowId === currentWindowId ? (
                  <Badge variant="secondary" title={t('openThisWindowTitle')}>
                    {t('openThisWindow')}
                  </Badge>
                ) : undefined
              }
              actions={
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onSaveWindow(window.windowId)}
                    disabled={busy}
                    title={t('openSaveWindowTitle')}
                  >
                    <Save />
                    {t('openSaveWindow')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    title={t('openCloseWindowTooltip')}
                    onClick={() =>
                      requestClose({
                        windowId: window.windowId,
                        windowNumber: index + 1,
                        tabCount: window.tabs.length,
                        isCurrent: window.windowId === currentWindowId,
                      })
                    }
                  >
                    <X />
                    {t('openCloseWindow')}
                  </Button>
                </>
              }
              onOpenTab={async (tabIndex) => {
                const tab = window.tabs[tabIndex];
                if (tab === undefined) {
                  return undefined;
                }
                const result = await goToTab(tab.tabId, window.windowId);
                return result.ok ? undefined : result.reason;
              }}
              tabSelection={(tabIndex) => {
                const tab = window.tabs[tabIndex];
                if (tab === undefined) {
                  return undefined;
                }
                return {
                  selected: selection.has(tab.tabId),
                  active: selection.size > 0,
                  onToggle: (shiftKey) => onToggleTab(tab.tabId, shiftKey),
                };
              }}
              renderTabActions={(tabIndex) => {
                const tab = window.tabs[tabIndex];
                if (tab === undefined) {
                  return undefined;
                }
                return (
                  <>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('openGoToTab')}
                      title={t('openGoToTab')}
                      onClick={() => activateTab(tab.tabId, window.windowId)}
                    >
                      <SquareArrowOutUpRight />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('openCloseTab')}
                      title={t('openCloseTab')}
                      onClick={() => removeTab(tab.tabId)}
                    >
                      <X />
                    </Button>
                  </>
                );
              }}
            />
          ))}
        </div>
      )}

      <CloseWindowDialog
        windowNumber={shown?.windowNumber}
        tabCount={shown?.tabCount ?? 0}
        isCurrent={shown?.isCurrent ?? false}
        open={pendingClose !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingClose(undefined);
          }
        }}
        onConfirm={confirmClose}
      />
    </section>
  );
}
