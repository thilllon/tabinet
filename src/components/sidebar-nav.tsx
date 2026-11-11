import { ChevronRight, Clock, FolderOpen, LayoutGrid, NotebookPen, Undo2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatRoute, type Route } from '@/lib/app-route';
import { formatDateTime } from '@/lib/display-format';
import { formatNumber, t, tp } from '@/lib/i18n';
import { videoTitle } from '@/lib/notes-export';
import { browserHandlesClick } from '@/lib/row-link';
import { HISTORY_OPEN_KEY, readUiState, writeUiState } from '@/lib/ui-state';
import { cn } from '@/lib/utils';
import type { NotesSummary, SessionSummary } from '@/types';

interface SidebarNavProps {
  route: Route;
  /** Saved sessions, newest first. */
  saved: SessionSummary[];
  /** Automatic snapshots, newest first. */
  history: SessionSummary[];
  /** Videos with YouTube notes, newest first. */
  notes: NotesSummary[];
  notesLoading: boolean;
  windowCount: number;
  tabCount: number;
  /** The snapshot promoted after a restart, if it is still the newest one. */
  recoveredId?: string;
  loading: boolean;
  onNavigate(route: Route): void;
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  sub: string;
  /** A second, quieter line: when this record was saved or taken. */
  time?: string;
  meta: React.ReactNode;
  current: boolean;
  /** The route this row leads to. Rendered as a real `href` - see the comment on NavItem. */
  route: Route;
  onClick(): void;
}

/**
 * One row of the sidebar, as an anchor rather than a button.
 *
 * These rows are navigation - each one has an address (`#saved/<id>`, `#settings`) - so the
 * browser should treat them as such: ⌘-click opens a session in its own tab, the context menu
 * offers "Copy link address", and the status bar previews the destination. A button can offer
 * none of that.
 *
 * A plain click is still handled in JS. Letting the hash change on its own would reach `useRoute`
 * through `hashchange` and look right, but it would skip everything else `go()` does - clearing a
 * stale notice, retiring the current search - so the two paths would drift apart.
 */
function NavItem({ icon, label, sub, time, meta, current, route, onClick }: NavItemProps) {
  return (
    <li>
      <a
        href={formatRoute(route)}
        title={label}
        aria-current={current ? 'page' : undefined}
        onClick={(event) => {
          if (browserHandlesClick(event)) {
            return;
          }
          event.preventDefault();
          onClick();
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
          // The hover tint belongs to the *unselected* branch. Written as a sibling of the
          // conditional it lost to it: a `hover:` variant outranks a plain utility, so hovering the
          // selected row painted over its own `bg-accent` and the highlight vanished under the
          // pointer. Keeping the two in one ternary makes that impossible to reintroduce.
          current
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <span aria-hidden="true" className="shrink-0 [&>svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          {/* Two lines rather than one truncated one: a default name carries the date and time,
              and cutting it off is exactly what makes the list unreadable at narrow widths. */}
          <span className="line-clamp-2 break-words">{label}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{sub}</span>
          {time !== undefined && (
            <span className="block truncate text-[11px] font-normal text-muted-foreground/80">
              {time}
            </span>
          )}
        </span>
        {meta}
      </a>
    </li>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-2 pt-4 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

/**
 * The left column: what you have (open tabs, saved sessions, YouTube notes, automatic snapshots) as one list, so
 * the main pane only ever shows what is selected. Snapshots stay folded away - they are a safety
 * net, not something to browse - except right after a restart, when the recovered one is called
 * out here instead of in a banner over the page.
 */
export function SidebarNav({
  route,
  saved,
  history,
  notes,
  notesLoading,
  windowCount,
  tabCount,
  recoveredId,
  loading,
  onNavigate,
}: SidebarNavProps) {
  const [historyOpen, setHistoryOpen] = useState(
    () => readUiState(HISTORY_OPEN_KEY) === 'open' || recoveredId !== undefined,
  );

  const toggleHistory = () => {
    setHistoryOpen((open) => {
      writeUiState(HISTORY_OPEN_KEY, open ? 'closed' : 'open');
      return !open;
    });
  };

  return (
    <nav aria-label={t('appNavLabel')} className="flex min-w-0 flex-col gap-0.5">
      <ul className="contents">
        <NavItem
          icon={<LayoutGrid />}
          label={t('appNavOpenTabs')}
          sub={tp('windowCount', windowCount)}
          meta={
            <span
              title={tp('appNavTabsOpen', tabCount)}
              className="font-mono text-xs text-muted-foreground"
            >
              {formatNumber(tabCount)}
            </span>
          }
          current={route.view === 'open'}
          route={{ view: 'open' }}
          onClick={() => onNavigate({ view: 'open' })}
        />
      </ul>

      <SectionLabel>{t('appNavSaved')}</SectionLabel>
      {loading ? (
        <p className="px-2 text-xs text-muted-foreground">{t('commonLoading')}</p>
      ) : saved.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">{t('appNavNothingSaved')}</p>
      ) : (
        <ul className="contents">
          {saved.map((summary) => (
            <NavItem
              key={summary.id}
              icon={<FolderOpen />}
              label={summary.name}
              sub={t(
                'commonWindowsAndTabs',
                tp('windowCount', summary.windowCount),
                tp('tabCount', summary.tabCount),
              )}
              time={t('appNavSavedAt', formatDateTime(summary.updatedAt))}
              meta={
                summary.unreadable === undefined ? undefined : (
                  <Badge variant="secondary" title={t('appNavNewerTitle')}>
                    {t('appNavNewerBadge')}
                  </Badge>
                )
              }
              current={route.view === 'saved' && route.id === summary.id}
              route={{ view: 'saved', id: summary.id }}
              onClick={() => onNavigate({ view: 'saved', id: summary.id })}
            />
          ))}
        </ul>
      )}

      <SectionLabel>{t('appNavNotes')}</SectionLabel>
      {notesLoading ? (
        <p className="px-2 text-xs text-muted-foreground">{t('commonLoading')}</p>
      ) : notes.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">{t('appNavNoNotes')}</p>
      ) : (
        <ul className="contents">
          {notes.map((summary) => (
            <NavItem
              key={summary.videoId}
              icon={<NotebookPen />}
              label={videoTitle(summary)}
              sub={tp('notesEntryCount', summary.entryCount)}
              time={t('notesUpdatedAt', formatDateTime(summary.updatedAt))}
              meta={undefined}
              current={route.view === 'notes' && route.videoId === summary.videoId}
              route={{ view: 'notes', videoId: summary.videoId }}
              onClick={() => onNavigate({ view: 'notes', videoId: summary.videoId })}
            />
          ))}
        </ul>
      )}

      <SectionLabel>{t('appNavAutoSaved')}</SectionLabel>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={historyOpen}
        title={historyOpen ? t('appNavHideSnapshots') : t('appNavShowSnapshots')}
        onClick={toggleHistory}
        className="justify-start gap-2 px-2 font-normal text-muted-foreground"
      >
        <Clock />
        <span className="flex-1 text-left">
          {history.length === 0
            ? t('appNavNoSnapshots')
            : tp('appNavSnapshotCount', history.length)}
        </span>
        <ChevronRight className={cn('transition-transform', historyOpen && 'rotate-90')} />
      </Button>
      {historyOpen && history.length > 0 && (
        <ul className="contents">
          {history.map((summary) => (
            <NavItem
              key={summary.id}
              icon={summary.id === recoveredId ? <Undo2 /> : <Clock />}
              label={formatDateTime(summary.createdAt)}
              sub={t(
                'commonWindowsAndTabs',
                tp('windowCount', summary.windowCount),
                tp('tabCount', summary.tabCount),
              )}
              meta={
                summary.id === recoveredId ? (
                  <Badge variant="secondary" title={t('appNavRecoveredTitle')}>
                    {t('appNavRecoveredBadge')}
                  </Badge>
                ) : summary.protected === true ? (
                  <Badge variant="outline" title={t('appNavKeptTitle')}>
                    {t('appNavKeptBadge')}
                  </Badge>
                ) : undefined
              }
              current={route.view === 'auto' && route.id === summary.id}
              route={{ view: 'auto', id: summary.id }}
              onClick={() => onNavigate({ view: 'auto', id: summary.id })}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
