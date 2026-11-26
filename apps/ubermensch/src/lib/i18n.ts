/**
 * Every string a person reads goes through `t()`: Chrome's own `chrome.i18n`, which picks the
 * browser's language from public/_locales and falls back to English key by key. The key type is
 * read from the English file (a type-only reference, nothing is bundled), so a missing key is a
 * type error.
 */
export type MessageKey = keyof typeof import('../../public/_locales/en/messages.json');

/** The message for `key` with `$1`..`$9` filled in from `subs`. */
export function t(key: MessageKey, ...subs: string[]): string {
  return chrome.i18n.getMessage(key, subs);
}

/** The language the text is actually shown in (`en` for a Chrome language that is not shipped). */
export function uiLocale(): string {
  return t('localeCode') || 'en';
}

/** Short independent facts on one line: "Location not visible · owner: Kim". */
export function joinFacts(facts: string[]): string {
  return facts.reduce((line, fact) => (line === '' ? fact : t('commonFactJoin', line, fact)), '');
}
