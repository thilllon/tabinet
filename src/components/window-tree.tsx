import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { GroupSection } from '@/components/group-section';
import { TabRow, type TabRowSelection } from '@/components/tab-row';
import { Button } from '@/components/ui/button';
import { windowStateLabel } from '@/lib/display-format';
import { formatNumber, t, tp } from '@/lib/i18n';
import { ROW_ACTIONS_CLASS } from '@/lib/row-actions';
import {
  hiddenTabCount,
  initialTabPage,
  nextTabPage,
  segmentTabs,
  showMoreLabel,
} from '@/lib/tab-rows';
import type { WindowSnapshot } from '@/types';

interface WindowTreeProps {
  /**
   * A saved `WindowSnapshot` or a live `OpenWindowView` - the live one is the same shape with
   * runtime ids added, so the tree renders both without knowing which it has.
   */
  window: Pick<WindowSnapshot, 'state' | 'groups' | 'tabs'>;
  index: number;
  /**
   * A row between the header and the tabs: the Open tabs list's select-all box for this window.
   * Left out (saved sessions, snapshots), the tree is exactly as before.
   */
  subheader?: ReactNode;
  /** Shown after the tab count, e.g. the open-windows pane's "This window" marker. */
  badge?: ReactNode;
  /** Header buttons, right-aligned (Restore window / Save this window / Close window / …). */
  actions?: ReactNode;
  /**
   * Called with a tab's absolute index in `window.tabs` when its row is clicked; resolves with an
   * error message to show inline, or undefined.
   */
  onOpenTab(tabIndex: number): Promise<string | undefined> | undefined;
  /** Trailing icon buttons for the tab at that absolute index. */
  renderTabActions?(tabIndex: number): ReactNode;
  /** Trailing buttons on a group header, by that group's index in `window.groups`. */
  renderGroupActions?(groupIndex: number): ReactNode;
  /** The tick box of the tab at that absolute index; left out, rows have none. */
  tabSelection?(tabIndex: number): TabRowSelection | undefined;
}

/**
 * One window as a `role="treeitem"` holding a `role="group"` of tab (and tab-group) rows. The
 * host renders it inside a `role="tree"` (the open-windows pane, a saved session's or a
 * snapshot's view), so the whole window → group → tab structure is one ARIA tree.
 *
 * Large windows are paged (`tab-rows.ts`): a 10,000-tab window mounts 200 rows and grows a page
 * per click, and every mounted row carries `content-visibility: auto` (see `index.css`) so the
 * ones off screen cost no layout.
 */
export function WindowTree({
  window,
  index,
  subheader,
  badge,
  actions,
  onOpenTab,
  renderTabActions,
  renderGroupActions,
  tabSelection,
}: WindowTreeProps) {
  const total = window.tabs.length;
  const [visible, setVisible] = useState(() => initialTabPage(total));

  // A different window in the same slot (a live pane refetch, another session expanded) starts
  // over at page one; growing the page count is otherwise the only thing that moves it.
  useEffect(() => {
    setVisible(initialTabPage(total));
  }, [total]);

  const shown = useMemo(
    () => (visible >= total ? window.tabs : window.tabs.slice(0, visible)),
    [window.tabs, visible, total],
  );
  // Segmenting the visible prefix keeps every callback index absolute: a segment's `startIndex`
  // is still its position in the full tab strip.
  const segments = useMemo(() => segmentTabs(shown), [shown]);
  const hidden = hiddenTabCount(visible, total);
  const windowLabel = t('treeWindowLabel', formatNumber(index + 1));
  const tabCount = tp('tabCount', total);

  return (
    <section
      // A window is a node of the sessions tree; it stays a <section> so its heading keeps
      // labelling a real region.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- see above
      role="treeitem"
      aria-expanded
      aria-label={windowLabel}
      // -1, not 0: the rows inside are what the Tab key walks (no roving tabindex here).
      tabIndex={-1}
      className="cv-window rounded-md border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-2 py-1">
        <h3 className="text-sm font-medium">{windowLabel}</h3>
        <span className="text-xs text-muted-foreground">
          {window.state !== 'normal'
            ? t('treeTabCountWithState', tabCount, windowStateLabel(window.state))
            : tabCount}
        </span>
        {badge}
        {actions !== undefined && (
          <div className={`ml-auto flex items-center gap-1 ${ROW_ACTIONS_CLASS}`}>{actions}</div>
        )}
      </header>
      {subheader}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <fieldset> is for form controls; this is the ARIA group of tab rows under a window node. */}
      <ul role="group" className="p-1">
        {segments.map((segment, segmentIndex) => {
          const groupIndex = segment.groupIndex;
          const group = groupIndex !== undefined ? window.groups[groupIndex] : undefined;
          if (group !== undefined && groupIndex !== undefined) {
            return (
              <GroupSection
                // oxlint-disable-next-line react/no-array-index-key -- no stable segment id
                key={`group-${segmentIndex}-${String(groupIndex)}`}
                group={group}
                tabs={segment.tabs}
                startIndex={segment.startIndex}
                actions={renderGroupActions?.(groupIndex)}
                onOpenTab={onOpenTab}
                renderTabActions={renderTabActions}
                tabSelection={tabSelection}
              />
            );
          }
          return segment.tabs.map((tab, tabIndex) => (
            <TabRow
              // oxlint-disable-next-line react/no-array-index-key -- no stable tab id; order is fixed.
              key={`tab-${segmentIndex}-${tabIndex}-${tab.url}`}
              tab={tab}
              selection={tabSelection?.(segment.startIndex + tabIndex)}
              onOpen={() => onOpenTab(segment.startIndex + tabIndex)}
              actions={renderTabActions?.(segment.startIndex + tabIndex)}
            />
          ));
        })}
      </ul>
      {hidden > 0 && (
        <div className="border-t px-2 py-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setVisible((current) => nextTabPage(current, total))}
            title={tp('treeShowMoreTabsTitle', hidden)}
          >
            {showMoreLabel(visible, total)}
          </Button>
        </div>
      )}
    </section>
  );
}
