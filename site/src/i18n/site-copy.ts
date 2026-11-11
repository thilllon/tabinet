import { en } from './copy-en';
import { es } from './copy-es';
import { ja } from './copy-ja';
import { ko } from './copy-ko';
import type { Locale } from './locales';

/** The screenshots the home page shows next to its feature rows. */
export type FeatureShot = 'restore' | 'notes' | 'history' | 'search' | 'settings';

export interface FeatureRow {
  shot: FeatureShot;
  kicker: string;
  title: string;
  body: string;
  points: string[];
  alt: string;
}

export type CardIcon = 'assemble' | 'transfer' | 'keyboard' | 'grouping';

export interface FeatureCard {
  icon: CardIcon;
  title: string;
  body: string;
}

export interface Faq {
  q: string;
  a: string;
}

/**
 * Every string the site shows, per language. Each language is written on its own terms, not
 * translated line by line, but they all say the same things: keep them in step with
 * the store Descriptions in scripts/store-listing.ts and PRIVACY_POLICY.md.
 */
export interface SiteCopy {
  meta: {
    homeTitle: string;
    homeDescription: string;
    supportTitle: string;
    supportDescription: string;
    privacyTitle: string;
    privacyDescription: string;
    ogImageAlt: string;
  };
  nav: {
    home: string;
    /** The header navigation landmark's label. */
    main: string;
    features: string;
    support: string;
    privacy: string;
    language: string;
    skipToContent: string;
    github: string;
  };
  cta: {
    addToChrome: string;
    note: string;
    seeFeatures: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    lead: string;
    imageAlt: string;
    /** Under the hero: the languages the extension itself is available in. */
    languages: string;
  };
  sort: {
    kicker: string;
    title: string;
    lead: string;
    before: string;
    after: string;
    beforeAlt: string;
    afterAlt: string;
    points: string[];
  };
  rows: FeatureRow[];
  more: {
    title: string;
    lead: string;
    cards: FeatureCard[];
  };
  promise: {
    title: string;
    lead: string;
    points: { title: string; body: string }[];
    link: string;
  };
  closing: {
    title: string;
    lead: string;
  };
  support: {
    title: string;
    lead: string;
    startTitle: string;
    startSteps: string[];
    reportTitle: string;
    reportLead: string;
    reportItems: string[];
    reportButton: string;
    openIssues: string;
    versionTitle: string;
    /** `{version}` is replaced with the current version number. */
    versionText: string;
    releases: string;
    requirement: string;
    faqTitle: string;
    faq: Faq[];
  };
  privacyPage: {
    /** Shown above the policy. English says it is the authoritative text; the others link to it. */
    notice: string;
    englishLink: string;
  };
  footer: {
    tagline: string;
    languages: string;
  };
}

const COPY: Record<Locale, SiteCopy> = { en, ko, es, ja };

export function copyFor(locale: Locale): SiteCopy {
  return COPY[locale];
}
