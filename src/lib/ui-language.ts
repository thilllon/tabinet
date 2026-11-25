import { LOCALE_ENDONYMS, SUPPORTED_LOCALES, type SupportedLocale } from '@/constants';
import { knownErrorText } from '@/lib/error-message';
import {
  appliedUiLanguage,
  applyUiLanguage,
  type CatalogReader,
  type LanguageChoice,
  t,
} from '@/lib/i18n';
import { flushMemoEditors } from '@/lib/memo-editor-state';

/**
 * The language the extension's own text is in, chosen in Settings: `'auto'` (the default) follows
 * Chrome's language through `chrome.i18n`, a code from `SUPPORTED_LOCALES` overrides it (see
 * `applyUiLanguage()` in `src/lib/i18n.ts`). It is a preference like the sort settings, so it
 * lives in `chrome.storage.sync` under its own key - never in `SortSettings`. The manifest's name
 * and the command descriptions at chrome://extensions are read by Chrome itself and stay in
 * Chrome's language.
 */
export type UiLanguage = LanguageChoice;

/** The `chrome.storage.sync` key. */
export const UI_LANGUAGE_KEY = 'uiLanguage';

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'auto';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'auto' || isSupportedLocale(value);
}

/** A stored value as a choice; anything missing or unknown reads as `'auto'`. */
export function parseUiLanguage(value: unknown): UiLanguage {
  return isUiLanguage(value) ? value : DEFAULT_UI_LANGUAGE;
}

/** The stored choice. A failed read is `'auto'`, so the text is never held up by storage. */
export async function loadUiLanguage(): Promise<UiLanguage> {
  try {
    const stored = await chrome.storage.sync.get(UI_LANGUAGE_KEY);
    return parseUiLanguage(stored[UI_LANGUAGE_KEY]);
  } catch (err) {
    console.error('[tabinet] language setting not read', err);
    return DEFAULT_UI_LANGUAGE;
  }
}

/** Writes the choice; rejects when Chrome refuses the write. */
export async function saveUiLanguage(language: UiLanguage): Promise<void> {
  await chrome.storage.sync.set({ [UI_LANGUAGE_KEY]: language });
}

/**
 * Reads the stored choice and puts it in use. Starts at once and never rejects; the text that
 * depends on it waits on `uiLanguageReady()` (`src/lib/i18n.ts`).
 */
export function applyStoredUiLanguage(read?: CatalogReader): Promise<void> {
  return applyUiLanguage(loadUiLanguage(), read);
}

/**
 * The choices of the language menu: Automatic in the current language, then every shipped
 * language in its own name, marked with its code as `lang` so a screen reader reads 日本語 with
 * a Japanese voice on an English page.
 */
export function uiLanguageOptions(): { value: UiLanguage; label: string; lang?: string }[] {
  return [
    { value: 'auto', label: t('settingsLanguageAuto') },
    ...SUPPORTED_LOCALES.map((code) => ({ value: code, label: LOCALE_ENDONYMS[code], lang: code })),
  ];
}

/**
 * Whether a `storage.onChanged` event chose a language other than the one this page is in
 * (`applied`): the choice was changed in another window or on another device, so the page must
 * reload into it. Pure; `followUiLanguageChanges()` wires it up.
 */
export function uiLanguageChangeNeedsReload(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
  applied: UiLanguage,
): boolean {
  if (areaName !== 'sync' || !(UI_LANGUAGE_KEY in changes)) {
    return false;
  }
  return parseUiLanguage(changes[UI_LANGUAGE_KEY]?.newValue) !== applied;
}

/**
 * Page only: reloads the page (`reload`) whenever the stored choice moves away from the language
 * in use, so a page left open never goes on naming saves and imports in the old one. The open memo
 * editors are saved first (`flushMemoEditors()`), so a reload never loses typed text. Returns the
 * function that stops listening.
 */
export function followUiLanguageChanges(reload: () => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: chrome.storage.AreaName,
  ) => {
    if (uiLanguageChangeNeedsReload(changes, areaName, appliedUiLanguage())) {
      void flushMemoEditors().then(reload);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * The error line for a language choice Chrome refused to store, in the UI language: Chrome's own
 * reason only when `error-message.ts` can explain it, never its English text.
 */
export function languageSaveFailedMessage(err: unknown): string {
  const reason = knownErrorText(err);
  return reason === undefined ? t('settingsSaveFailedPlain') : t('settingsSaveFailed', reason);
}
