import { getAbsoluteLocaleUrl, getRelativeLocaleUrl } from 'astro:i18n';

import {
  DEFAULT_LOCALE as EXTENSION_DEFAULT_LOCALE,
  LOCALE_ENDONYMS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '../../../src/constants';

/**
 * The extension's languages (`SUPPORTED_LOCALES` in src/constants.ts), which astro.config.ts
 * also reads for `i18n.locales`. English is the default and has no prefix.
 */
export const LOCALES = SUPPORTED_LOCALES;
export type Locale = SupportedLocale;
export const DEFAULT_LOCALE: Locale = EXTENSION_DEFAULT_LOCALE;

/** Each language's name in that language, as the language switch shows it. */
export const LOCALE_NAMES: Record<Locale, string> = LOCALE_ENDONYMS;

/** `og:locale` values. */
export const OG_LOCALES: Record<Locale, string> = {
  en: 'en_US',
  es: 'es_419',
  ko: 'ko_KR',
  ja: 'ja_JP',
};

export const PAGES = ['home', 'support', 'privacy'] as const;
export type Page = (typeof PAGES)[number];

const SLUGS: Record<Page, string> = {
  home: '',
  support: 'support/',
  privacy: 'privacy/',
};

/** Root-relative URL of a page in a language, base path included: `/tabinet/ko/support/`. */
export function pageUrl(locale: Locale, page: Page): string {
  return getRelativeLocaleUrl(locale, SLUGS[page]);
}

/** The same URL, absolute, for canonical links, hreflang alternates and Open Graph. */
export function absolutePageUrl(locale: Locale, page: Page): string {
  return getAbsoluteLocaleUrl(locale, SLUGS[page]);
}

/** `getStaticPaths()` result shared by every page under `[...locale]`. */
export function localePaths() {
  return LOCALES.map((locale) => ({
    params: { locale: locale === DEFAULT_LOCALE ? undefined : locale },
    props: { locale },
  }));
}

export const STORE_URL =
  'https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg';
export const REPO_URL = 'https://github.com/thilllon/tabinet';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;
export const RELEASES_URL = `${REPO_URL}/releases`;
