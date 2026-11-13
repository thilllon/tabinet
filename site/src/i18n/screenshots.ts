import { DEFAULT_LOCALE, type Locale } from './locales';

// Every store screenshot, one folder per UI language with the same file names: assets/en/ for
// English, assets/<code>/ for the others (scripts/prepare-registration.ts, LOCALES=...).
const SHOTS = import.meta.glob<{ default: ImageMetadata }>('../../../assets/*/*.png', {
  eager: true,
});

/** The screenshot `name` with the extension in `locale`'s language, or the English one. */
export function screenshot(locale: Locale, name: string): ImageMetadata {
  const found =
    SHOTS[`../../../assets/${locale}/${name}.png`] ??
    SHOTS[`../../../assets/${DEFAULT_LOCALE}/${name}.png`];
  if (found === undefined) {
    throw new Error(`assets/${DEFAULT_LOCALE}/${name}.png is missing`);
  }
  return found.default;
}
