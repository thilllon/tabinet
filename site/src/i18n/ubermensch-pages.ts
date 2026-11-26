import { getAbsoluteLocaleUrl, getRelativeLocaleUrl } from 'astro:i18n';

import type { Locale } from './locales';

/** The Übermensch pages, under /tabinet/ubermensch/ (and /tabinet/<lang>/ubermensch/). */
export const UBERMENSCH_PAGES = ['home', 'support', 'privacy'] as const;
export type UbermenschPage = (typeof UBERMENSCH_PAGES)[number];

const SLUGS: Record<UbermenschPage, string> = {
  home: 'ubermensch/',
  support: 'ubermensch/support/',
  privacy: 'ubermensch/privacy/',
};

export function ubermenschUrl(locale: Locale, page: UbermenschPage): string {
  return getRelativeLocaleUrl(locale, SLUGS[page]);
}

export function absoluteUbermenschUrl(locale: Locale, page: UbermenschPage): string {
  return getAbsoluteLocaleUrl(locale, SLUGS[page]);
}

export const UBERMENSCH_ISSUES_URL = 'https://github.com/thilllon/tabinet/issues/new';
