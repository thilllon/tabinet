import { Pin } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Favicon } from '@/components/favicon';
import { useErrorToast } from '@/hooks/use-toasts';
import { hostnameOf } from '@/lib/display-format';
import { t } from '@/lib/i18n';
import { ROW_ACTIONS_CLASS } from '@/lib/row-actions';
import { browserHandlesClick, hrefFor } from '@/lib/row-link';
import type { TabSnapshot } from '@/types';

/** A row's tick box, where the list has a selection (the Open tabs list). */
export interface TabRowSelection {
  selected: boolean;
  /** Something in the list is ticked: every row then shows its box, not only the hovered one. */
  active: boolean;
  /** `shiftKey` asks for the whole range from the row ticked last. */
  onToggle(shiftKey: boolean): void;
}

interface TabRowProps {
  tab: TabSnapshot;
  /** Left out, the row has no tick box at all (saved sessions, snapshots, search results). */
  selection?: TabRowSelection;
  /**
   * What a click on the row does (go to the live tab, or open the saved url); resolves with an
   * error message to show on the row, or undefined.
   */
  onOpen(): Promise<string | undefined> | undefined;
  /** Trailing icon buttons (Go to tab / Close tab / Remove from session). */
  actions?: ReactNode;
}

export function TabRow({ tab, selection, onOpen, actions }: TabRowProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  useErrorToast(error);

  const open = () => {
    void Promise.resolve(onOpen()).then(setError);
  };

  /**
   * An `href` only so the browser will show where the row goes (status bar, "Copy link address",
   * ⌘-click). `hrefFor` returns undefined for anything that must not be a live link, and the row
   * falls back to the button it has always been - behaviour on a plain click is identical either
   * way, so nothing is lost by a url that cannot be linked.
   */
  const href = hrefFor(tab.url);

  const onClick = (event: React.MouseEvent) => {
    if (browserHandlesClick(event)) {
      // ⌘/Ctrl/Shift-click: the user asked for the browser's behaviour, so leave the anchor alone.
      return;
    }
    // A plain click must not navigate this page to the site - that would close the app.
    event.preventDefault();
    open();
  };

  const label = tab.title.length > 0 ? tab.title : tab.url;
  // The tooltip carries the full title as well as the address: both are cut short in the row.
  const rowTitle = error ?? (label === tab.url ? tab.url : `${label}\n${tab.url}`);
  const inner = (
    <>
      <Favicon url={tab.url} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
        {hostnameOf(tab.url)}
      </span>
      {tab.pinned && (
        <Pin className="size-3 shrink-0 text-muted-foreground" aria-label={t('treePinned')} />
      )}
    </>
  );
  const rowClass =
    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

  return (
    // `cv-tab-row` (index.css) lets Chrome skip layout for rows scrolled out of view - the one
    // thing that keeps a 10,000-tab session scrolling smoothly.
    <li role="treeitem" tabIndex={-1} className="cv-tab-row">
      {/* The actions sit beside the row button, never inside it: a button may not nest buttons. */}
      <div
        className={`group/row flex items-center gap-1 rounded-md pr-1 hover:bg-accent ${selection?.selected ? 'bg-accent' : ''}`}
      >
        {/*
         * Beside the row link, never inside it, for the same reason as the actions. Clicking the
         * row still goes to the tab; only the box selects. It waits for the pointer like the
         * actions do, until something is ticked - from then on every row shows its box, because
         * a list in which only one row admits to being selectable looks broken.
         */}
        {selection !== undefined && (
          <input
            type="checkbox"
            aria-label={t('treeSelectTab', label)}
            title={t('treeSelectTabHint')}
            checked={selection.selected}
            onChange={(event) =>
              selection.onToggle(
                event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey,
              )
            }
            className={`ml-1.5 size-3.5 shrink-0 translate-y-[0.5px] cursor-pointer accent-primary transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 ${selection.active ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        {href === undefined ? (
          <button type="button" onClick={open} title={rowTitle} className={rowClass}>
            {inner}
          </button>
        ) : (
          <a href={href} onClick={onClick} title={rowTitle} className={rowClass}>
            {inner}
          </a>
        )}
        {/*
         * Two or three icon buttons on every row, times a few hundred rows, is most of what makes
         * a long session look like noise - so they wait until the pointer is on the row.
         *
         * Hidden with opacity, not `display`, for three reasons: the row does not reflow when
         * they appear, they stay in the tab order, and `group-focus-within` brings them back the
         * moment one is focused, so a keyboard never chases an invisible control. The
         * `hover: none` query covers touch screens, where there is no hover to reveal them with
         * and hiding them would simply remove the feature.
         */}
        <span
          className={`flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 ${ROW_ACTIONS_CLASS}`}
        >
          {actions}
        </span>
      </div>
    </li>
  );
}
