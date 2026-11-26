import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOCS_ORIGINS } from '@/constants';

import {
  CWS_SUMMARY_MAX_CHARS,
  DATA_TYPES,
  DATA_USAGE,
  DESCRIPTION_MAX_CHARS,
  HOST_PERMISSIONS_AND_REMOTE_CODE,
  LISTING_LOCALES,
  OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS,
  PERMISSION_JUSTIFICATIONS,
  readLocaleMessage,
  SINGLE_PURPOSE,
  STORE_DESCRIPTIONS,
  TEST_INSTRUCTIONS,
} from '../../scripts/store-listing';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LONG_DASH = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

/** The manifest's `permissions` array in vite.config.ts, read as text. */
function manifestPermissions(): string[] {
  const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8');
  const block = /^\s*permissions:\s*\[([^\]]*)\]/m.exec(config);
  if (block?.[1] === undefined) {
    throw new Error('No permissions array in vite.config.ts');
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('the store listing', () => {
  it('justifies exactly the permissions the manifest asks for', () => {
    expect(Object.keys(PERMISSION_JUSTIFICATIONS).sort()).toEqual(manifestPermissions().sort());
    expect(Object.keys(OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS)).toEqual([...DOCS_ORIGINS]);
    for (const origin of DOCS_ORIGINS) {
      expect(HOST_PERMISSIONS_AND_REMOTE_CODE).toContain(origin);
    }
  });

  it('keeps every Description plain and within the owner limit', () => {
    for (const code of LISTING_LOCALES) {
      const description = STORE_DESCRIPTIONS[code];
      expect([...description].length, code).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
      expect(LONG_DASH.test(description), code).toBe(false);
      expect(description, code).not.toMatch(/[*#`]/);
      // The button the reader is told to click has the extension's own wording in that language.
      expect(description, code).toContain(readLocaleMessage(code, 'pathShowButton'));
    }
  });

  it('keeps the Summary (extDescription) within the store limit', () => {
    for (const code of LISTING_LOCALES) {
      expect([...readLocaleMessage(code, 'extDescription')].length, code).toBeLessThanOrEqual(
        CWS_SUMMARY_MAX_CHARS,
      );
    }
  });

  it('quotes the extension own labels in the test instructions', () => {
    for (const key of [
      'pathShowButton',
      'optionsDocsAccess',
      'optionsSignOut',
      'optionsClearCache',
    ] as const) {
      expect(TEST_INSTRUCTIONS).toContain(readLocaleMessage('en', key));
    }
  });

  it('has no long dash in any text', () => {
    const texts = [
      SINGLE_PURPOSE,
      DATA_USAGE,
      DATA_TYPES.justification,
      TEST_INSTRUCTIONS,
      HOST_PERMISSIONS_AND_REMOTE_CODE,
      ...Object.values(PERMISSION_JUSTIFICATIONS),
    ];
    for (const text of texts) {
      expect(LONG_DASH.test(text)).toBe(false);
    }
  });
});
