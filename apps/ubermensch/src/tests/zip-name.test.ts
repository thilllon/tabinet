import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPackage, zipFileName } from '../../scripts/zip-name';

describe('zipFileName', () => {
  it('takes the accents off the display name', () => {
    expect(zipFileName('Übermensch', '0.1.0')).toBe('Ubermensch-0.1.0.zip');
    expect(zipFileName(' Two  Words ', '1.2.3')).toBe('Two-Words-1.2.3.zip');
  });

  it('refuses a message reference', () => {
    expect(() => zipFileName('__MSG_extName__', '1.0.0')).toThrow();
  });

  it('reads this package', () => {
    const pkg = readPackage(path.resolve(import.meta.dirname, '../../package.json'));
    expect(pkg.displayName).toBe('Übermensch');
    expect(zipFileName(pkg.displayName, pkg.version)).toBe(`Ubermensch-${pkg.version}.zip`);
  });
});
