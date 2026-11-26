import type { Locale } from './locales';

/**
 * The Übermensch screenshots (apps/ubermensch/assets/<code>/drive-path-<n>.png, made from a
 * fixture page by apps/ubermensch/scripts/screenshots.ts), English where a language has none.
 */
const SHOTS = import.meta.glob<{ default: ImageMetadata }>(
  '../../../apps/ubermensch/assets/*/drive-path-*.png',
  {
    eager: true,
  },
);

export function ubermenschShot(locale: Locale, n: 1 | 2 | 3 | 4 | 5): ImageMetadata {
  const own = SHOTS[`../../../apps/ubermensch/assets/${locale}/drive-path-${n}.png`];
  const english = SHOTS[`../../../apps/ubermensch/assets/en/drive-path-${n}.png`];
  const shot = own ?? english;
  if (shot === undefined) {
    throw new Error(`No Übermensch screenshot ${n}`);
  }
  return shot.default;
}
