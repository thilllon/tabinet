import { DEFAULT_LOCALE, type SupportedLocale } from '@/constants';

/**
 * Every string a person reads goes through here. The text lives in `public/_locales/<lang>/messages.json`
 * (copied to the extension root, where Chrome looks for it); `chrome.i18n` picks the browser's UI
 * language and falls back to English (`default_locale`) for a missing key, so English must always
 * have every key. Messages use `$1`..`$9` for substitutions (a literal dollar sign is `$$`).
 *
 * Chrome has no plural support, so a counted phrase is a family of keys, `<base>_one`,
 * `<base>_other` (and whatever else the language's plural rules use, such as Spanish `_many`).
 * `tp()` picks the key with `Intl.PluralRules` for the language of the text shown (`uiLocale()`,
 * the `localeCode` message) and falls back to `_other`; Korean and Japanese only ever need `_other`.
 *
 * Chrome picks the language and offers no way to switch it, so a language chosen in Settings
 * (`src/lib/ui-language.ts`) is an override: `applyUiLanguage()` loads that language's packaged
 * `messages.json` (and English, for the keys it lacks) into memory, and from then on `t()` and
 * `tp()` read those catalogs, filled in exactly as `chrome.i18n.getMessage` fills them in. With no
 * override (`'auto'`, the default) they call `chrome.i18n.getMessage` as before.
 */
import type enMessages from '../../public/_locales/en/messages.json';

export type MessageKey = keyof typeof enMessages;

type PluralBaseOf<K> = K extends `${infer Base}_other` ? Base : never;
/** A key family `tp()` can count with: every `<base>_other` in the English messages. */
type PluralBase = PluralBaseOf<MessageKey>;

type Substitution = string | number;

/** One entry of a `messages.json`, as far as filling it in is concerned. */
interface CatalogEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

/** A whole `messages.json`: entries by message name. */
type Catalog = Record<string, CatalogEntry>;

/** Reads one language's packaged `messages.json`; tests pass one that reads `public/_locales`. */
export type CatalogReader = (locale: SupportedLocale) => Promise<unknown>;

/** `'auto'` is Chrome's own choice (`chrome.i18n`); a code is a language chosen in Settings. */
export type LanguageChoice = 'auto' | SupportedLocale;

/**
 * The catalogs `t()` reads while a language is chosen: that language's, then English for a key it
 * lacks (Chrome's own per-key fallback to `default_locale`). `undefined` means Chrome decides.
 */
let override: { primary: Catalog; fallback: Catalog } | undefined;
/** The choice actually in use: `'auto'` again when the chosen language's catalog could not be read. */
let applied: LanguageChoice = 'auto';
/** Settles when the language last asked for is in use (or has failed, and Chrome's is). */
let ready: Promise<void> = Promise.resolve();
/** Which `applyUiLanguage()` call is the latest, so an older, slower load never wins. */
let generation = 0;

/** The message for `key` in the UI language, with `$1`.. filled in from `substitutions`. */
export function t(key: MessageKey, ...substitutions: Substitution[]): string {
  return message(key, substitutions.map(String));
}

function message(name: string, substitutions: string[]): string {
  if (override === undefined) {
    return chrome.i18n.getMessage(name, substitutions);
  }
  const entry = override.primary[name] ?? override.fallback[name];
  return entry === undefined ? '' : formatMessage(entry, substitutions);
}

/**
 * An entry filled in the way `chrome.i18n.getMessage` does it: each named placeholder (`$NAME$`,
 * any case) becomes its `content` first, as Chrome does when it loads the file; then `$1`..`$9`
 * become the substitutions (an empty string for one not given) and `$$` a literal dollar sign.
 */
export function formatMessage(entry: CatalogEntry, substitutions: readonly string[]): string {
  return expandPlaceholders(entry).replace(/\$(\$|[1-9])/g, (_match, ref: string) =>
    ref === '$' ? '$' : (substitutions[Number(ref) - 1] ?? ''),
  );
}

/**
 * The message with each named placeholder (`$NAME$`, any case) replaced by its `content`, as
 * Chrome does when it loads the file; an unknown name is left as it is. Only `$1`..`$9` and `$$`
 * remain to be filled in.
 */
export function expandPlaceholders(entry: CatalogEntry): string {
  const placeholders = Object.entries(entry.placeholders ?? {});
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (match, name: string) => {
    const found = placeholders.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found === undefined ? match : found[1].content;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPlaceholders(value: unknown): CatalogEntry['placeholders'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const placeholders: Record<string, { content: string }> = {};
  for (const [name, placeholder] of Object.entries(value)) {
    if (isRecord(placeholder) && typeof placeholder.content === 'string') {
      placeholders[name] = { content: placeholder.content };
    }
  }
  return placeholders;
}

/** The well-formed entries of a parsed `messages.json`; anything else is left out. */
export function toCatalog(value: unknown): Catalog {
  const catalog: Catalog = {};
  if (!isRecord(value)) {
    return catalog;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry) && typeof entry.message === 'string') {
      const placeholders = toPlaceholders(entry.placeholders);
      catalog[name] =
        placeholders === undefined
          ? { message: entry.message }
          : { message: entry.message, placeholders };
    }
  }
  return catalog;
}

/**
 * The packaged file, fetched from the extension's own root (`_locales` is copied there as it is).
 * A `fetch` of the extension's own URL works in the page and in the service worker alike.
 */
export async function readPackagedCatalog(locale: SupportedLocale): Promise<unknown> {
  const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
  if (!response.ok) {
    throw new Error(`_locales/${locale}/messages.json: HTTP ${response.status}`);
  }
  const parsed: unknown = await response.json();
  return parsed;
}

/**
 * Puts `choice` in use for every later `t()` / `tp()`. `'auto'` hands the text back to
 * `chrome.i18n`; a language code loads its catalog and English. Never rejects: a catalog that
 * cannot be read leaves Chrome's language in use and is logged. `choice` may be a promise (a
 * stored setting still being read), so a caller can start this synchronously and every reader
 * waits on `uiLanguageReady()`. A later call wins over an earlier one that is still loading.
 */
export function applyUiLanguage(
  choice: LanguageChoice | Promise<LanguageChoice>,
  read: CatalogReader = readPackagedCatalog,
): Promise<void> {
  generation += 1;
  const mine = generation;
  ready = (async () => {
    let next: typeof override;
    let nextChoice: LanguageChoice = 'auto';
    try {
      const language = await choice;
      if (language !== 'auto') {
        const [primary, fallback] = await Promise.all([
          read(language).then(toCatalog),
          language === DEFAULT_LOCALE ? {} : read(DEFAULT_LOCALE).then(toCatalog),
        ]);
        next = { primary, fallback };
        nextChoice = language;
      }
    } catch (err) {
      console.error('[tabinet] language not loaded; using Chrome language', err);
      next = undefined;
      nextChoice = 'auto';
    }
    if (mine === generation) {
      override = next;
      applied = nextChoice;
    }
  })();
  return ready;
}

/**
 * Settles once the language last passed to `applyUiLanguage()` is in use. Code that makes text in
 * the service worker (a menu title, a session name) waits on it first, because the worker
 * registers its listeners before the stored choice has been read.
 */
export function uiLanguageReady(): Promise<void> {
  return ready;
}

/**
 * The choice in use once `uiLanguageReady()` has settled: the language last passed to
 * `applyUiLanguage()`, or `'auto'` when that was `'auto'` or its catalog could not be read (the
 * text is then in Chrome's language, whatever is stored). The Settings menu shows this, so it
 * never names a language the page is not in.
 */
export function appliedUiLanguage(): LanguageChoice {
  return applied;
}

/**
 * A counted phrase: `$1` is `count` formatted for the UI language, `$2`.. are `extra`.
 * `tp('tabCount', 3)` is "3 tabs" in English and "탭 3개" in Korean.
 */
export function tp(base: PluralBase, count: number, ...extra: Substitution[]): string {
  const substitutions = [formatNumber(count), ...extra.map(String)];
  const exact = message(`${base}_${pluralRules().select(count)}`, substitutions);
  return exact !== '' ? exact : message(`${base}_other`, substitutions);
}

/**
 * The language the text is actually shown in, as a BCP 47 tag, for every `Intl` call and the
 * page's `lang`. Not `chrome.i18n.getUILanguage()`: for a Chrome language the extension does not
 * ship (French, Portuguese...) Chrome falls back to the English messages, and the plurals and
 * number formats must then be English too, or the page would read "1 234,5 tabs". So each
 * `messages.json` names its own language in `localeCode`, and whichever file Chrome picked answers.
 */
export function uiLocale(): string {
  return t('localeCode') || 'en';
}

/**
 * Two (or more) complete sentences as one text, the way the UI language puts sentences side by
 * side: a space in English, Korean and Spanish, nothing in Japanese. Empty sentences are left out.
 * Never use it to build a sentence out of fragments; that needs a message of its own.
 */
export function joinSentences(...sentences: string[]): string {
  return sentences
    .filter((sentence) => sentence !== '')
    .reduce(
      (joined, sentence) => (joined === '' ? sentence : t('commonSentenceJoin', joined, sentence)),
      '',
    );
}

/** Short facts on one line ("3 windows · 87 tabs"), separated the way the UI language does it. */
export function joinFacts(facts: readonly string[]): string {
  return facts
    .filter((fact) => fact !== '')
    .reduce((joined, fact) => (joined === '' ? fact : t('commonFactJoin', joined, fact)), '');
}

let cachedRules: { locale: string; rules: Intl.PluralRules } | undefined;
let cachedNumbers: { locale: string; format: Intl.NumberFormat } | undefined;

function pluralRules(): Intl.PluralRules {
  const locale = uiLocale();
  if (cachedRules?.locale !== locale) {
    cachedRules = { locale, rules: new Intl.PluralRules(locale) };
  }
  return cachedRules.rules;
}

/** `n` with the UI language's digit grouping. */
export function formatNumber(n: number): string {
  const locale = uiLocale();
  if (cachedNumbers?.locale !== locale) {
    cachedNumbers = { locale, format: new Intl.NumberFormat(locale) };
  }
  return cachedNumbers.format.format(n);
}
