import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCALE_ENDONYMS, SUPPORTED_LOCALES } from '@/constants';
import { ExplainedError } from '@/lib/error-message';
import { applyUiLanguage, t, toCatalog, uiLocale } from '@/lib/i18n';
import {
  applyStoredUiLanguage,
  DEFAULT_UI_LANGUAGE,
  followUiLanguageChanges,
  isSupportedLocale,
  isUiLanguage,
  languageSaveFailedMessage,
  loadUiLanguage,
  parseUiLanguage,
  saveUiLanguage,
  UI_LANGUAGE_KEY,
  uiLanguageChangeNeedsReload,
  uiLanguageOptions,
} from '@/lib/ui-language';

import { getChromeFake, readLocaleFile } from './chrome-fake';

afterEach(async () => {
  await applyUiLanguage('auto');
  vi.restoreAllMocks();
});

describe('parseUiLanguage', () => {
  it("keeps 'auto' and every shipped language", () => {
    expect(parseUiLanguage('auto')).toBe('auto');
    for (const code of SUPPORTED_LOCALES) {
      expect(parseUiLanguage(code)).toBe(code);
      expect(isSupportedLocale(code)).toBe(true);
    }
  });

  it("reads anything else as 'auto'", () => {
    for (const value of [undefined, null, '', 'fr', 'EN', 'ko-KR', 3, {}, ['en']]) {
      expect(parseUiLanguage(value)).toBe('auto');
      expect(isUiLanguage(value)).toBe(false);
    }
    expect(isSupportedLocale('auto')).toBe(false);
    expect(DEFAULT_UI_LANGUAGE).toBe('auto');
  });
});

describe('loadUiLanguage / saveUiLanguage', () => {
  it("is 'auto' until something is stored", async () => {
    await expect(loadUiLanguage()).resolves.toBe('auto');
  });

  it('stores the choice in sync storage under its own key', async () => {
    await saveUiLanguage('ja');
    expect(getChromeFake().state.sync.get(UI_LANGUAGE_KEY)).toBe('ja');
    await expect(loadUiLanguage()).resolves.toBe('ja');
  });

  it("reads a damaged value, or a failed read, as 'auto'", async () => {
    getChromeFake().state.sync.set(UI_LANGUAGE_KEY, 'klingon');
    await expect(loadUiLanguage()).resolves.toBe('auto');

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(chrome.storage.sync, 'get').mockRejectedValue(new Error('sync unavailable'));
    await expect(loadUiLanguage()).resolves.toBe('auto');
  });
});

describe('applyStoredUiLanguage', () => {
  it('puts the stored language in use', async () => {
    getChromeFake().state.sync.set(UI_LANGUAGE_KEY, 'ko');
    await applyStoredUiLanguage(readLocaleFile);
    expect(uiLocale()).toBe('ko');
    const ko = toCatalog(await readLocaleFile('ko'));
    expect(t('commonCancel')).toBe(ko.commonCancel?.message);
    expect(t('commonCancel')).not.toBe('Cancel');
  });

  it("leaves Chrome's language in use with nothing stored", async () => {
    getChromeFake().setUiLanguage('es');
    const read = vi.fn(readLocaleFile);
    await applyStoredUiLanguage(read);
    expect(read).not.toHaveBeenCalled();
    expect(uiLocale()).toBe('es');
  });
});

describe('uiLanguageOptions', () => {
  it('offers Automatic first, then every language in its own name', () => {
    expect(uiLanguageOptions()).toEqual([
      { value: 'auto', label: t('settingsLanguageAuto') },
      ...SUPPORTED_LOCALES.map((code) => ({
        value: code,
        label: LOCALE_ENDONYMS[code],
        lang: code,
      })),
    ]);
    // Automatic is in the page's language, so it carries no `lang` of its own.
    expect(uiLanguageOptions()[0]).not.toHaveProperty('lang');
  });

  it('translates only Automatic', async () => {
    const english = uiLanguageOptions();
    await applyUiLanguage('ja', readLocaleFile);
    const japanese = uiLanguageOptions();
    expect(japanese[0]?.label).not.toBe(english[0]?.label);
    expect(japanese.slice(1)).toEqual(english.slice(1));
  });
});

describe('uiLanguageChangeNeedsReload', () => {
  const change = (newValue: unknown) => ({ [UI_LANGUAGE_KEY]: { newValue } });

  it('reloads when another window or device picks a language the page is not in', () => {
    expect(uiLanguageChangeNeedsReload(change('ko'), 'sync', 'auto')).toBe(true);
    expect(uiLanguageChangeNeedsReload(change('auto'), 'sync', 'ja')).toBe(true);
    // Removed, or a damaged value: both read as Automatic.
    expect(uiLanguageChangeNeedsReload({ [UI_LANGUAGE_KEY]: {} }, 'sync', 'es')).toBe(true);
    expect(uiLanguageChangeNeedsReload(change('klingon'), 'sync', 'es')).toBe(true);
  });

  it('stays when the page is already in it, or the change is about something else', () => {
    expect(uiLanguageChangeNeedsReload(change('ko'), 'sync', 'ko')).toBe(false);
    expect(uiLanguageChangeNeedsReload(change('ko'), 'local', 'auto')).toBe(false);
    expect(uiLanguageChangeNeedsReload({ sortBy: { newValue: 'url' } }, 'sync', 'auto')).toBe(
      false,
    );
  });
});

describe('followUiLanguageChanges', () => {
  it('reloads the page when the stored choice moves away from the one in use', async () => {
    await applyUiLanguage('ja', readLocaleFile);
    const reload = vi.fn();
    const stop = followUiLanguageChanges(reload);

    await saveUiLanguage('ja');
    expect(reload).not.toHaveBeenCalled();
    await chrome.storage.sync.set({ sortBy: 'title' });
    expect(reload).not.toHaveBeenCalled();
    await saveUiLanguage('ko');
    expect(reload).toHaveBeenCalledTimes(1);

    stop();
    await saveUiLanguage('es');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('languageSaveFailedMessage', () => {
  it("never shows Chrome's own English text", () => {
    expect(
      languageSaveFailedMessage(new Error('QUOTA_BYTES_PER_ITEM quota exceeded?')),
    ).not.toContain('QUOTA_BYTES_PER_ITEM');
    expect(languageSaveFailedMessage(new Error('Something internal'))).toBe(
      t('settingsSaveFailedPlain'),
    );
    expect(languageSaveFailedMessage(undefined)).toBe(t('settingsSaveFailedPlain'));
  });

  it('names a reason this page can explain', () => {
    expect(languageSaveFailedMessage(new ExplainedError('x', 'errorTabsBusy'))).toBe(
      t('settingsSaveFailed', t('errorTabsBusy')),
    );
  });
});
