import { t, tp, uiLocale } from '@/lib/i18n';
import type { SessionSummary, WindowSnapshot } from '@/types';

/**
 * A size number in the UI language's digits and decimal mark. No digit grouping, so a value just
 * under the next unit reads "1023.9", as it always has.
 */
function formatSize(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat(uiLocale(), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: false,
  }).format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return t('treeSizeBytes', formatSize(bytes, 0));
  }
  if (bytes < 1024 * 1024) {
    return t('treeSizeKilobytes', formatSize(bytes / 1024, 1));
  }
  return t('treeSizeMegabytes', formatSize(bytes / (1024 * 1024), 1));
}

export function formatSessionMeta(
  summary: Pick<SessionSummary, 'windowCount' | 'tabCount' | 'bytes'>,
): string {
  return t(
    'treeSessionMeta',
    tp('windowCount', summary.windowCount),
    tp('tabCount', summary.tabCount),
    formatBytes(summary.bytes),
  );
}

export function hostnameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.hostname;
  }
  // chrome://extensions/ -> "chrome://extensions", about:blank -> "about:blank". A non-http(s)
  // scheme parses its authority as `hostname` too (e.g. "extensions"), so branch on protocol
  // rather than on `hostname.length` and fall back to the trimmed input url.
  return url.replace(/\/+$/, '');
}

export function formatDateTime(epochMs: number): string {
  return new Intl.DateTimeFormat(uiLocale(), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

/** A window's state as a person reads it, for the window header ("Minimized"). */
export function windowStateLabel(state: WindowSnapshot['state']): string {
  switch (state) {
    case 'minimized':
      return t('treeWindowStateMinimized');
    case 'maximized':
      return t('treeWindowStateMaximized');
    case 'fullscreen':
      return t('treeWindowStateFullscreen');
    case 'normal':
      return t('treeWindowStateNormal');
  }
}

/** A time of day in the UI language, with seconds for a time that may be under a minute away. */
export function formatClockTime(epochMs: number, precision?: 'seconds'): string {
  return new Intl.DateTimeFormat(uiLocale(), {
    timeStyle: precision === 'seconds' ? 'medium' : 'short',
  }).format(new Date(epochMs));
}
