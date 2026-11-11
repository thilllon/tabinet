import { Upload } from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';

import { DialogCloseButton } from '@/components/dialog-close-button';
import { QuotaNotice } from '@/components/quota-notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isQuotaError, reportError } from '@/lib/error-message';
import { formatNumber, t, tp } from '@/lib/i18n';
import {
  buildImportPreview,
  checkImportSize,
  fileReadError,
  formatImportTotals,
  type ImportPreview,
  importButtonLabel,
  importFormatLabel,
  utf8ByteLength,
} from '@/lib/import-preview';
import { type ImportFormat, importSessions } from '@/lib/session-import';
import { sessionRepo } from '@/lib/session-repo';
import { revealStorageMeter } from '@/lib/storage-meter';
import type { Session } from '@/types';

/** Extensions the picker offers; every one of them is handled by a parser in session-import.ts. */
const IMPORT_ACCEPT = '.json,.html,.htm,.md,.txt';

/** Stands in for the format name so it can be drawn in bold wherever the translation puts it. */
const FORMAT_SLOT = '\uE000';

type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'error'; error: string }
  | {
      kind: 'ready';
      format: ImportFormat;
      sessions: Session[];
      warnings: string[];
      preview: ImportPreview;
    };

interface ImportDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Called with the number of sessions written; the dashboard shows the confirmation. */
  onImported(count: number): void;
}

/**
 * File picker + paste box for importing sessions. The parsers are pure
 * (`src/lib/session-import.ts`), so the whole preview - detected format, warnings, the session →
 * window → tab tree and the totals - is computed from the text before a single write happens.
 * Committing writes each session through `sessionRepo.put`, which takes the Web Lock per session.
 */
export function ImportDialog({ open, onOpenChange, onImported }: ImportDialogProps) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [quotaFull, setQuotaFull] = useState(false);
  const [busy, setBusy] = useState(false);

  // A dialog reopened after an import must not still show the previous one's preview.
  useEffect(() => {
    if (!open) {
      setText('');
      setFileName(undefined);
      setError(undefined);
      setQuotaFull(false);
      setBusy(false);
    }
  }, [open]);

  /**
   * Parse + preview, recomputed only when the text itself changes (a keystroke in the paste box,
   * or a file that finished reading). `Date.now()` is read here rather than passed in: it only
   * stamps the imported sessions' createdAt/updatedAt, and the ones this build produces are the
   * ones the commit below writes.
   */
  const parsed = useMemo<ParsedInput>(() => {
    if (text.trim() === '') {
      return { kind: 'empty' };
    }
    const size = checkImportSize(utf8ByteLength(text));
    if (!size.ok) {
      return { kind: 'error', error: size.error };
    }
    const result = importSessions(text, Date.now());
    if (result.format === null) {
      return { kind: 'error', error: result.error };
    }
    return {
      kind: 'ready',
      format: result.format,
      sessions: result.sessions,
      warnings: result.warnings,
      preview: buildImportPreview(result.sessions),
    };
  }, [text]);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    // Checked before the read, so an oversized file is never pulled into memory at all.
    const size = checkImportSize(file.size);
    if (!size.ok) {
      setText('');
      setFileName(file.name);
      setError(size.error);
      return;
    }
    setBusy(true);
    file
      .text()
      .then((content) => {
        setFileName(file.name);
        setError(undefined);
        setText(content);
      })
      .catch((err: unknown) => {
        setText('');
        setError(fileReadError(err));
      })
      .finally(() => setBusy(false));
  };

  const commit = async () => {
    if (parsed.kind !== 'ready') {
      return;
    }
    setBusy(true);
    setQuotaFull(false);
    try {
      for (const session of parsed.sessions) {
        await sessionRepo.put(session);
      }
      onImported(parsed.sessions.length);
      onOpenChange(false);
    } catch (err) {
      // An import writes session after session, so a full disk shows up here more often than
      // anywhere else - and the sessions written before it are kept.
      if (isQuotaError(err)) {
        setError(undefined);
        setQuotaFull(true);
      } else {
        setError(reportError('import', err));
      }
    } finally {
      setBusy(false);
    }
  };

  const shownError = error ?? (parsed.kind === 'error' ? parsed.error : undefined);
  const textareaLabel = t('expPasteLabel');
  const [detectedBefore, detectedAfter = ''] = t('expDetected', FORMAT_SLOT).split(FORMAT_SLOT);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('expImportTitle')}</DialogTitle>
          <DialogDescription>{t('expImportDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="import-file">{t('expChooseFile')}</Label>
          <Input id="import-file" type="file" accept={IMPORT_ACCEPT} onChange={handleFile} />
          {fileName !== undefined && <p className="text-xs text-muted-foreground">{fileName}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="import-text">{textareaLabel}</Label>
          <textarea
            id="import-text"
            aria-label={textareaLabel}
            value={text}
            spellCheck={false}
            rows={5}
            placeholder={t('expPastePlaceholder')}
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            onChange={(event) => {
              setError(undefined);
              setFileName(undefined);
              setText(event.target.value);
            }}
          />
        </div>

        {quotaFull && (
          <QuotaNotice
            onShowStorage={() => {
              onOpenChange(false);
              // Radix locks body scrolling while the dialog is open; scroll once it has closed.
              revealStorageMeter(250);
            }}
          />
        )}

        {shownError !== undefined && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {shownError}
          </p>
        )}

        {parsed.kind === 'ready' && (
          <div className="grid gap-2">
            <p className="text-sm">
              {detectedBefore}
              <strong>{importFormatLabel(parsed.format)}</strong>
              {detectedAfter}
              {t('commonFactJoin', '', formatImportTotals(parsed.preview))}
            </p>
            {parsed.warnings.length > 0 && (
              <ul className="list-inside list-disc text-xs text-muted-foreground">
                {parsed.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <div className="max-h-64 overflow-y-auto rounded-md border p-2">
              <ul className="space-y-2">
                {parsed.preview.sessions.map((previewSession, sessionIndex) => (
                  <li
                    // oxlint-disable-next-line react/no-array-index-key -- preview names are not unique
                    key={`session-${sessionIndex}`}
                  >
                    <p className="truncate text-sm font-medium" title={previewSession.name}>
                      {previewSession.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'commonWindowsAndTabs',
                        tp('windowCount', previewSession.windowCount),
                        tp('tabCount', previewSession.tabCount),
                      )}
                    </p>
                    <ul className="mt-1 ml-2 space-y-1 border-l pl-2">
                      {previewSession.windows.map((previewWindow) => (
                        <li key={previewWindow.number}>
                          <p className="text-xs font-medium">
                            {tp(
                              'expPreviewWindow',
                              previewWindow.tabCount,
                              formatNumber(previewWindow.number),
                            )}
                          </p>
                          <ul className="text-xs text-muted-foreground">
                            {previewWindow.titles.map((title, titleIndex) => (
                              <li
                                // oxlint-disable-next-line react/no-array-index-key -- titles repeat
                                key={`title-${titleIndex}`}
                                className="truncate"
                                title={title}
                              >
                                {title}
                              </li>
                            ))}
                            {previewWindow.moreTabs > 0 && (
                              <li>{tp('expMoreTabs', previewWindow.moreTabs)}</li>
                            )}
                          </ul>
                        </li>
                      ))}
                      {previewSession.moreWindows > 0 && (
                        <li className="text-xs text-muted-foreground">
                          {tp('expMoreWindows', previewSession.moreWindows)}
                        </li>
                      )}
                    </ul>
                  </li>
                ))}
              </ul>
              {parsed.preview.moreSessions > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {tp('expMoreSessions', parsed.preview.moreSessions)}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('commonCancel')}
          </Button>
          <Button disabled={parsed.kind !== 'ready' || busy} onClick={() => void commit()}>
            <Upload />
            {parsed.kind === 'ready' ? importButtonLabel(parsed.sessions.length) : t('expImport')}
          </Button>
        </DialogFooter>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
