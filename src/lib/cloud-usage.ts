/**
 * The Cloud storage row of Settings > Account (#261): how much of the account's limit is used.
 */
import { formatByteLimit, formatBytes } from '@/lib/display-format';
import { t } from '@/lib/i18n';
import type { Usage } from '@/types';

/** `12.3 MB / 50 MB`: the used half as `formatBytes()`, the limit without a forced decimal. */
export function cloudUsageText(usage: Usage, limit: number): string {
  return t('settingsAccountUsageValue', formatBytes(usage.bytes), formatByteLimit(limit));
}

/** The usage to show: a ready device's own reading of the feed, else what `me` reported. Pure. */
export function preferredUsage(fromSync: Usage | null, fromMe: Usage | null): Usage | null {
  return fromSync ?? fromMe;
}
