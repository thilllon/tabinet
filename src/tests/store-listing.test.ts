import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CWS_SUMMARY_MAX_CHARS,
  DATA_CERTIFICATIONS,
  DATA_TYPES,
  DATA_USAGE,
  DESCRIPTION_MAX_CHARS,
  HOST_PERMISSIONS_AND_REMOTE_CODE,
  LISTING_LOCALES,
  LOCALES_SOURCE,
  OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS,
  PERMISSION_JUSTIFICATIONS,
  PRODUCT_DETAILS,
  readLocaleMessage,
  SINGLE_PURPOSE,
  STORE_DESCRIPTIONS,
  TEST_INSTRUCTIONS,
  validateDescription,
  validateSummary,
} from '../../scripts/store-listing';
import { cloudSyncPermissions, YOUTUBE_ORIGINS } from '../constants';

const ROOT = path.resolve(LOCALES_SOURCE, '..', '..');
const LONG_DASH = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

/**
 * The `permissions` array of the manifest in vite.config.ts, read as text (no plugins loaded),
 * plus what its `...cloudSyncPermissions()` spread adds (`identity` while cloud sync is configured).
 */
function manifestPermissions(): string[] {
  const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8');
  const block = /^\s*permissions:\s*\[([^\]]*)\]/m.exec(config);
  if (block === null) {
    throw new Error('No permissions array in vite.config.ts');
  }
  const literal = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const spreads = block[1].includes('...cloudSyncPermissions()') ? cloudSyncPermissions() : [];
  return [...literal, ...spreads];
}

describe('validateDescription', () => {
  it('accepts a description at the limit', () => {
    expect(() => validateDescription('a'.repeat(DESCRIPTION_MAX_CHARS))).not.toThrow();
  });

  it(`rejects a description longer than ${DESCRIPTION_MAX_CHARS} characters`, () => {
    expect(() => validateDescription('a'.repeat(DESCRIPTION_MAX_CHARS + 1))).toThrow(/at most 500/);
  });
});

describe('validateSummary', () => {
  it('accepts a summary within the limit', () => {
    expect(() => validateSummary('a'.repeat(CWS_SUMMARY_MAX_CHARS))).not.toThrow();
  });

  it(`rejects a summary longer than ${CWS_SUMMARY_MAX_CHARS} characters`, () => {
    expect(() => validateSummary('a'.repeat(CWS_SUMMARY_MAX_CHARS + 1))).toThrow(/at most 132/);
  });
});

describe('the store listing', () => {
  it('has a Description for exactly the shipped languages', () => {
    expect(Object.keys(STORE_DESCRIPTIONS)).toEqual([...LISTING_LOCALES]);
  });

  describe.each([...LISTING_LOCALES])('%s', (locale) => {
    const description = STORE_DESCRIPTIONS[locale];
    const summary = readLocaleMessage(LOCALES_SOURCE, locale, 'extDescription');

    it('has a description the store will accept', () => {
      expect(description.trim()).not.toBe('');
      expect(() => validateDescription(description)).not.toThrow();
    });

    it('keeps Markdown out of the description, since it is pasted as it is', () => {
      expect(description).not.toMatch(/^#{1,6}\s/m);
      expect(description).not.toMatch(/\*\*|`/);
      expect(description).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    });

    it('links its own language’s support page', () => {
      const prefix = locale === 'en' ? '' : `${locale}/`;
      expect(description).toContain(`https://thilllon.github.io/tabinet/${prefix}support/`);
    });

    it('has a Summary (extDescription) the store will accept', () => {
      expect(summary).toBeDefined();
      expect(() => validateSummary(summary ?? '')).not.toThrow();
    });

    it('quotes the Assemble! button in that language’s wording', () => {
      const assembleName = readLocaleMessage(LOCALES_SOURCE, locale, 'assembleName');
      expect(assembleName).toBeDefined();
      expect(description).toContain(assembleName);
    });

    it('has no em or en dash', () => {
      expect(description).not.toMatch(LONG_DASH);
      expect(summary).not.toMatch(LONG_DASH);
    });
  });

  it('keeps package.json description equal to the English Summary', () => {
    const pkg: { description?: string } = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf-8'),
    );
    expect(pkg.description).toBe(readLocaleMessage(LOCALES_SOURCE, 'en', 'extDescription'));
  });

  it('justifies exactly the permissions the manifest requests', () => {
    expect(Object.keys(PERMISSION_JUSTIFICATIONS).toSorted()).toEqual(
      manifestPermissions().toSorted(),
    );
  });

  it('justifies exactly the optional host permissions the manifest declares, and asks for none at install', () => {
    const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8');
    // The manifest spreads the one list in src/constants.ts; this pins that it still does.
    expect(config).toMatch(/^\s*optional_host_permissions: \[\.\.\.YOUTUBE_ORIGINS\],$/m);
    expect(config).not.toMatch(/^\s*host_permissions:/m);
    expect(config).not.toMatch(/^\s*content_scripts:/m);
    expect(Object.keys(OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS).toSorted()).toEqual(
      [...YOUTUBE_ORIGINS].toSorted(),
    );
    for (const origin of YOUTUBE_ORIGINS) {
      expect(HOST_PERMISSIONS_AND_REMOTE_CODE).toContain(origin);
    }
  });

  it('quotes UI labels in the test instructions exactly as the English messages say them', () => {
    const english: Record<string, { message: string }> = JSON.parse(
      readFileSync(path.join(LOCALES_SOURCE, 'en', 'messages.json'), 'utf-8'),
    );
    const messages = new Set(Object.values(english).map((entry) => entry.message));
    // "Options" is Chrome's own menu item, not one of ours.
    const quoted = [...TEST_INSTRUCTIONS.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((label) => label !== 'Options');
    expect(quoted.length).toBeGreaterThan(0);
    for (const label of quoted) {
      expect(messages, label).toContain(label);
    }
  });

  it('fills every privacy answer and the test instructions, without a long dash', () => {
    const texts = [
      SINGLE_PURPOSE,
      ...Object.values(PERMISSION_JUSTIFICATIONS),
      ...Object.values(OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS),
      HOST_PERMISSIONS_AND_REMOTE_CODE,
      DATA_USAGE,
      ...DATA_CERTIFICATIONS,
      DATA_TYPES.justification,
      TEST_INSTRUCTIONS,
      ...Object.values(PRODUCT_DETAILS),
    ];
    for (const text of texts) {
      expect(text.trim()).not.toBe('');
      expect(text).not.toMatch(LONG_DASH);
    }
    expect(DATA_CERTIFICATIONS).toHaveLength(3);
  });
});
