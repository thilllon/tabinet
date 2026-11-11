import {
  AlignLeft,
  Braces,
  Copy,
  Download,
  FileCode,
  FileText,
  Link,
  type LucideIcon,
  Table2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { copyText, downloadExport } from '@/lib/download-and-copy';
import { reportError } from '@/lib/error-message';
import {
  buildExportScope,
  copiedLinksNotice,
  copiedMarkdownNotice,
  exportedNotice,
  exportFormatItems,
  exportScopeName,
} from '@/lib/export-actions';
import { t } from '@/lib/i18n';
import { countTabs } from '@/lib/restore-messages';
import { scopeToSession, serialize, toMarkdown, toText } from '@/lib/session-export';
import { sessionRepo } from '@/lib/session-repo';
import type { ExportFormat, Session, SessionSummary } from '@/types';

const FORMAT_ICONS: Record<ExportFormat, LucideIcon> = {
  json: Braces,
  markdown: FileText,
  text: AlignLeft,
  html: FileCode,
  csv: Table2,
};

interface ExportMenuProps {
  /** The index entry the scope belongs to: the id to load, and the name for the filename. */
  summary: Pick<SessionSummary, 'id' | 'name'>;
  /**
   * The already-loaded body of the view that hosts this menu. Left out (still loading), the
   * body is read through `sessionRepo.get` on demand.
   */
  session?: Session;
  /** Narrows the export to one window of the session. */
  windowIndex?: number;
  /** Narrows it further to one group of that window; needs `windowIndex`. */
  groupIndex?: number;
  size?: 'icon-xs' | 'icon-sm';
  /** "Exported …" / "Copied …" - shown as a toast by the app. */
  onNotice(message: string): void;
  /** A failed read, a refused clipboard write - shown wherever the host puts its errors. */
  onError(message: string): void;
}

/**
 * Export / copy menu, used in a saved session's and a snapshot's header and on each window and
 * group of a saved session - the scope is whatever `windowIndex` / `groupIndex` narrow it to.
 *
 * Everything it does is local: `serialize()` builds the text, a Blob URL downloads it and
 * `navigator.clipboard` takes the copies. No network request, no `downloads` permission, and no
 * write of any kind - this menu only reads through `sessionRepo`.
 */
export function ExportMenu({
  summary,
  session,
  windowIndex,
  groupIndex,
  size = 'icon-sm',
  onNotice,
  onError,
}: ExportMenuProps) {
  /**
   * Resolves the body (loading it when the host has none), narrows it to this menu's scope and
   * hands both the scoped session and its display name to `run`. A stale index - a window or
   * group removed since the render - makes `scopeToSession` throw, which lands in `onError`
   * rather than escaping the click handler.
   */
  const withScope = async (run: (scoped: Session, name: string) => void | Promise<void>) => {
    try {
      const body = session ?? (await sessionRepo.get(summary.id));
      if (body === undefined) {
        onError(t('sessionGone'));
        return;
      }
      const scoped = scopeToSession(buildExportScope(body, windowIndex, groupIndex));
      if (countTabs(scoped) === 0) {
        onNotice(t('expNothingToExport'));
        return;
      }
      await run(scoped, exportScopeName(body, windowIndex, groupIndex));
    } catch (err) {
      onError(reportError('export', err));
    }
  };

  const handleExport = (format: ExportFormat) => {
    void withScope((scoped, name) => {
      downloadExport(name, format, serialize(format, [scoped], Date.now()));
      onNotice(exportedNotice(name, format));
    });
  };

  const handleCopy = (as: 'links' | 'markdown') => {
    void withScope(async (scoped) => {
      const result = await copyText(as === 'links' ? toText([scoped]) : toMarkdown([scoped]));
      if (!result.ok) {
        onError(result.error);
        return;
      }
      const count = countTabs(scoped);
      onNotice(as === 'links' ? copiedLinksNotice(count) : copiedMarkdownNotice(count));
    });
  };

  return (
    <DropdownMenu>
      {/* The trigger is never disabled while an export runs: Radix hands focus back to it as the
          menu closes, and a disabled trigger would drop that focus to <body>. Every action here
          is a read, so a second click at worst writes the same file twice. */}
      <DropdownMenuTrigger asChild>
        <Button
          size={size}
          variant="ghost"
          aria-label={t('expMenuButton')}
          title={
            groupIndex !== undefined
              ? t('expMenuTitleGroup')
              : windowIndex !== undefined
                ? t('expMenuTitleWindow')
                : t('expMenuTitleAll')
          }
        >
          <Download />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {exportFormatItems().map(({ format, label }) => {
          const Icon = FORMAT_ICONS[format];
          return (
            <DropdownMenuItem key={format} onSelect={() => handleExport(format)}>
              <Icon />
              {label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => handleCopy('links')}>
          <Link />
          {t('expCopyLinks')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleCopy('markdown')}>
          <Copy />
          {t('expCopyMarkdown')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
