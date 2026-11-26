import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@/constants';
import { joinFacts, t, uiLocale } from '@/lib/i18n';

import { getChromeFake } from './setup';

const LOCALES_DIR = path.resolve(import.meta.dirname, '../../public/_locales');
const LONG_DASH = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

type Catalog = Record<string, { message: string; description?: string }>;

function catalog(code: string): Catalog {
  return JSON.parse(readFileSync(path.join(LOCALES_DIR, code, 'messages.json'), 'utf8'));
}

function placeholders(message: string): string[] {
  return [...new Set(message.match(/\$[1-9]/g) ?? [])].sort();
}

describe('_locales', () => {
  const en = catalog('en');

  it('ships exactly the supported languages', () => {
    expect(readdirSync(LOCALES_DIR).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('describes every English message, with a name Chrome accepts', () => {
    for (const [key, entry] of Object.entries(en)) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/);
      expect(entry.description, key).toBeTruthy();
    }
  });

  for (const code of SUPPORTED_LOCALES) {
    it(`${code}: same keys and placeholders as English, nothing empty, no long dash`, () => {
      const messages = catalog(code);
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const [key, entry] of Object.entries(messages)) {
        expect(entry.message.trim(), `${code}.${key}`).not.toBe('');
        expect(placeholders(entry.message), `${code}.${key}`).toEqual(
          placeholders(en[key]?.message ?? ''),
        );
        expect(LONG_DASH.test(entry.message), `${code}.${key}`).toBe(false);
        // Chrome drops `$0`, `$x` or a lone `$`; only `$1`..`$9` and `$$` are valid.
        expect(entry.message.replaceAll('$$', '').replaceAll(/\$[1-9]/g, '')).not.toContain('$');
      }
      expect(messages.localeCode?.message).toBe(code);
      expect(messages.extName?.message).toBe('Übermensch');
    });
  }

  it('keeps the summary within the store limit in every language', () => {
    for (const code of SUPPORTED_LOCALES) {
      expect([...(catalog(code).extDescription?.message ?? '')].length, code).toBeLessThanOrEqual(
        132,
      );
    }
  });
});

describe('t()', () => {
  it('fills placeholders and follows the language', () => {
    expect(t('pathOwner', 'Kim')).toBe('owner: Kim');
    expect(joinFacts(['a', 'b', 'c'])).toBe('a · b · c');
    expect(uiLocale()).toBe('en');
    getChromeFake().state.language = 'ja';
    expect(t('pathOwner', 'Kim')).toBe('オーナー: Kim');
    expect(uiLocale()).toBe('ja');
  });
});
