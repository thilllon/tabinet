import { errorDetail, knownErrorText } from '@/lib/error-message';
import { t } from '@/lib/i18n';
import { exportFilename, mimeTypeFor } from '@/lib/session-export';
import type { ExportFormat } from '@/types';

/**
 * The two local sinks the dashboard's export / copy actions write to: a Blob-URL download and
 * the clipboard. Neither leaves the device and neither needs a permission - an
 * extension page may create an `<a download>` on a Blob URL and click it itself, so the
 * `downloads` permission is deliberately NOT requested.
 *
 * Filenames and MIME types are not invented here: both come from `src/lib/session-export.ts`, so a
 * new format is added in one place.
 */

interface DownloadDescriptor {
  filename: string;
  mimeType: string;
}

/** What `downloadExport` will name the file, and the type it will hand the browser. */
export function downloadDescriptor(
  base: string,
  format: ExportFormat,
  date: Date = new Date(),
): DownloadDescriptor {
  return { filename: exportFilename(base, format, date), mimeType: mimeTypeFor(format) };
}

/**
 * Chrome starts the download asynchronously after the click, so the object URL is revoked on a
 * later task - revoking it in the same one cancels the download before it begins. The delay is
 * generous on purpose: the URL costs a few bytes, a cancelled download costs the user their data.
 */
const REVOKE_DELAY_MS = 60_000;

/** Saves `text` as `filename`. No-ops outside a DOM (vitest runs in Node). */
function downloadText(filename: string, mimeType: string, text: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/** `downloadText` with the filename and MIME type resolved from the format. */
export function downloadExport(
  base: string,
  format: ExportFormat,
  text: string,
  date: Date = new Date(),
): DownloadDescriptor {
  const descriptor = downloadDescriptor(base, format, date);
  downloadText(descriptor.filename, descriptor.mimeType, text);
  return descriptor;
}

type CopyResult = { ok: true } | { ok: false; error: string };

export function copyFailureMessage(err: unknown): string {
  console.warn('[tabinet] copy failed', errorDetail(err));
  const reason = knownErrorText(err);
  return reason === undefined ? t('expCopyFailedPlain') : t('expCopyFailed', reason);
}

/**
 * `navigator.clipboard.writeText`, which an extension page may call while it has focus. Never
 * throws: a browser without the API and a rejected write both come back as a readable
 * `{ ok: false, error }` for the caller to show in the app's error line.
 */
export async function copyText(text: string): Promise<CopyResult> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return { ok: false, error: t('expClipboardUnavailable') };
  }
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: copyFailureMessage(err) };
  }
}
