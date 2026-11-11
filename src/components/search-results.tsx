import { NotebookPen, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';

import { Favicon } from '@/components/favicon';
import { Button } from '@/components/ui/button';
import { formatRoute } from '@/lib/app-route';
import { formatSessionMeta, hostnameOf } from '@/lib/display-format';
import { formatNumber, t, tp } from '@/lib/i18n';
import { browserHandlesClick, hrefFor } from '@/lib/row-link';
import { resultPlace, splitOnMatches } from '@/lib/search-engine';
import type { SearchGroup, SearchItem } from '@/lib/search-nav';
import { formatTimestamp } from '@/lib/youtube-video';

interface SearchResultsProps {
  /** Grouped rows from `buildSearchGroups()`; `startIndex` addresses the flattened list. */
  groups: SearchGroup[];
  /** The query as typed, for the "no matches" line. */
  query: string;
  /** `tokenize()` output - what `splitOnMatches` highlights. */
  tokens: string[];
  /** Matches across every source, including the ones beyond the per-source cap. */
  total: number;
  /** Index into the flattened list, or `NO_HIGHLIGHT`. */
  highlight: number;
  onHighlight(index: number): void;
  onActivate(index: number): void;
  /** Raises the per-source cap (the "Show more" button of any truncated group). */
  onShowMore(): void;
  /** True while session bodies are still being read: the counts can still grow. */
  warming: boolean;
}

/** Highlighted text, as `<mark>` elements - never `dangerouslySetInnerHTML`. */
function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  return (
    <>
      {splitOnMatches(text, tokens).map((segment, index) =>
        segment.match ? (
          <mark
            // oxlint-disable-next-line react/no-array-index-key -- segments are positional by definition
            key={index}
            className="rounded-xs bg-primary/20 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional by definition
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

const ROW = 'flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm';

/** Ties a row to its index in the flattened list, so the highlight can scroll it into view. */
function rowId(index: number): string {
  return `search-result-${String(index)}`;
}

function TabResultRow({
  item,
  tokens,
  index,
  highlighted,
  onHighlight,
  onActivate,
}: {
  item: Extract<SearchItem, { kind: 'tab' }>;
  tokens: string[];
  index: number;
  highlighted: boolean;
  onHighlight(index: number): void;
  onActivate(index: number): void;
}) {
  const { entry } = item;
  const place = resultPlace(entry);
  // Same deal as TabRow: the href is there for the status bar, ⌘-click and "Copy link address".
  // Enter on the highlighted row still goes through onActivate, so the keyboard path is unchanged.
  const href = hrefFor(entry.url);
  const shared = {
    id: rowId(index),
    // The full title as well as the address: both can be cut short in the row.
    title: entry.title.length > 0 ? `${entry.title}\n${entry.url}` : entry.url,
    'aria-current': highlighted ? ('true' as const) : undefined,
    onMouseEnter: () => onHighlight(index),
    onFocus: () => onHighlight(index),
    className: `${ROW} w-full min-w-0 ${highlighted ? 'bg-accent' : 'hover:bg-accent'}`,
  };
  const inner = (
    <>
      <Favicon url={entry.url} />
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={entry.title.length > 0 ? entry.title : entry.url} tokens={tokens} />
      </span>
      <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
        {hostnameOf(entry.url)}
      </span>
      <span className="max-w-48 shrink-0 truncate text-xs text-muted-foreground" title={place}>
        {place}
      </span>
    </>
  );
  return (
    <li>
      {href === undefined ? (
        <button type="button" onClick={() => onActivate(index)} {...shared}>
          {inner}
        </button>
      ) : (
        <a
          href={href}
          onClick={(event) => {
            if (browserHandlesClick(event)) {
              return;
            }
            event.preventDefault();
            onActivate(index);
          }}
          {...shared}
        >
          {inner}
        </a>
      )}
    </li>
  );
}

/**
 * A YouTube note: its time, its text (or that it is a screenshot) and the video it is on. A link
 * to the video's notes on this page, where the time links to the video itself.
 */
function NoteResultRow({
  item,
  tokens,
  index,
  highlighted,
  onHighlight,
  onActivate,
}: {
  item: Extract<SearchItem, { kind: 'note' }>;
  tokens: string[];
  index: number;
  highlighted: boolean;
  onHighlight(index: number): void;
  onActivate(index: number): void;
}) {
  const { entry } = item;
  const time = formatTimestamp(entry.at ?? 0);
  const text = entry.title.replace(/\s+/g, ' ').trim();
  const video = entry.sessionName === '' ? t('notesUntitledVideo') : entry.sessionName;
  return (
    <li>
      <a
        id={rowId(index)}
        href={formatRoute({ view: 'notes', videoId: entry.videoId ?? '' })}
        title={entry.title.length > 0 ? `${entry.title}\n${video}` : video}
        aria-current={highlighted ? 'true' : undefined}
        onMouseEnter={() => onHighlight(index)}
        onFocus={() => onHighlight(index)}
        onClick={(event) => {
          if (browserHandlesClick(event)) {
            return;
          }
          event.preventDefault();
          onActivate(index);
        }}
        className={`${ROW} w-full min-w-0 ${highlighted ? 'bg-accent' : 'hover:bg-accent'}`}
      >
        <NotebookPen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {time}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {text === '' ? (
            <span className="text-muted-foreground">{t('notesScreenshotAt', time)}</span>
          ) : (
            <Highlighted text={text} tokens={tokens} />
          )}
        </span>
        <span className="max-w-64 shrink-0 truncate text-xs text-muted-foreground">
          <Highlighted text={video} tokens={tokens} />
        </span>
      </a>
    </li>
  );
}

function SessionResultRow({
  item,
  tokens,
  index,
  highlighted,
  onHighlight,
  onActivate,
}: {
  item: Extract<SearchItem, { kind: 'session' }>;
  tokens: string[];
  index: number;
  highlighted: boolean;
  onHighlight(index: number): void;
  onActivate(index: number): void;
}) {
  const { summary } = item;
  return (
    <li>
      {/* The row itself is not a control: its one action is the Restore button beside it. */}
      <div
        id={rowId(index)}
        aria-current={highlighted ? 'true' : undefined}
        className={`${ROW} ${highlighted ? 'bg-accent' : 'hover:bg-accent'}`}
      >
        <span className="min-w-0 flex-1 truncate font-medium" title={summary.name}>
          <Highlighted text={summary.name} tokens={tokens} />
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatSessionMeta(summary)}</span>
        <Button
          size="xs"
          variant="outline"
          onMouseEnter={() => onHighlight(index)}
          onFocus={() => onHighlight(index)}
          onClick={() => onActivate(index)}
        >
          <RotateCcw />
          {t('searchRestoreSession')}
        </Button>
      </div>
    </li>
  );
}

/**
 * The search results, shown in place of the dashboard's normal content while a query is active.
 * Rows are grouped by source with a per-source count and capped at `DEFAULT_LIMIT_PER_SOURCE`;
 * the highlight index is shared with `SearchBar`'s arrow keys, so the same row responds to Enter
 * and to a click.
 */
export function SearchResults({
  groups,
  query,
  tokens,
  total,
  highlight,
  onHighlight,
  onActivate,
  onShowMore,
  warming,
}: SearchResultsProps) {
  // Arrow keys move the highlight while focus stays in the search box, so the list has to follow
  // it itself. `block: 'nearest'` scrolls only when the row is actually out of view.
  useEffect(() => {
    if (highlight < 0) {
      return;
    }
    document.getElementById(rowId(highlight))?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  return (
    <section aria-labelledby="search-results-heading" className="min-w-0">
      <div className="flex items-center gap-2">
        <h2 id="search-results-heading" className="text-sm font-semibold">
          {t('searchResultsHeading')}
        </h2>
        {/* Nothing but the count lives in the live region, so it announces "12 results". */}
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a live region, not a form's <output>. */}
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {tp('searchResultCount', total)}
        </p>
        {warming && (
          <span className="text-xs text-muted-foreground">{t('searchStillLoading')}</span>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('searchNoMatches', query)}</p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((group) => (
            <div key={group.source}>
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.heading}
                </h3>
                <span className="text-xs text-muted-foreground">{formatNumber(group.count)}</span>
              </div>
              <ul className="mt-1">
                {group.items.map((item, offset) => {
                  const index = group.startIndex + offset;
                  if (item.kind === 'note') {
                    return (
                      <NoteResultRow
                        key={item.key}
                        item={item}
                        tokens={tokens}
                        index={index}
                        highlighted={index === highlight}
                        onHighlight={onHighlight}
                        onActivate={onActivate}
                      />
                    );
                  }
                  return item.kind === 'session' ? (
                    <SessionResultRow
                      key={item.key}
                      item={item}
                      tokens={tokens}
                      index={index}
                      highlighted={index === highlight}
                      onHighlight={onHighlight}
                      onActivate={onActivate}
                    />
                  ) : (
                    <TabResultRow
                      key={item.key}
                      item={item}
                      tokens={tokens}
                      index={index}
                      highlighted={index === highlight}
                      onHighlight={onHighlight}
                      onActivate={onActivate}
                    />
                  );
                })}
              </ul>
              {group.hasMore && (
                <Button size="xs" variant="ghost" className="mt-1" onClick={onShowMore}>
                  {t('searchShowMore')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
