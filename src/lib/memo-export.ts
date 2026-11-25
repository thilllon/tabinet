import { t } from '@/lib/i18n';
import { memoTitle } from '@/lib/memo-repo';
import type { Memo } from '@/types';

/**
 * A memo as a Markdown file (spec 12.1): the text exactly as written, named after its title (the
 * first line), or "Untitled memo" when it has none. Pure but for the UI language.
 */
export function memoExport(memo: Pick<Memo, 'text'>): { base: string; text: string } {
  const title = memoTitle(memo.text);
  return { base: title === '' ? t('memoUntitled') : title, text: memo.text };
}

/** The title a memo is listed and shown under. */
export function memoDisplayTitle(title: string): string {
  return title === '' ? t('memoUntitled') : title;
}
