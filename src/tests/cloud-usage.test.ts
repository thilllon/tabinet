import { afterEach, describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import { cloudUsageText, preferredUsage } from '@/lib/cloud-usage';

import { getChromeFake } from './chrome-fake';

const MIB = 1024 * 1024;
const usage = (bytes: number) => ({ bytes, screenshots: 0 });

afterEach(() => {
  getChromeFake().setUiLanguage('en');
});

describe('cloudUsageText', () => {
  it('shows the used bytes with one decimal and the limit without a forced one', () => {
    expect(cloudUsageText(usage(Math.round(12.3 * MIB)), POLICY.account.storageBytes)).toBe(
      '12.3 MB / 50 MB',
    );
  });

  it('shows zero and a value over the limit as they are', () => {
    expect(cloudUsageText(usage(0), POLICY.account.storageBytes)).toBe('0 B / 50 MB');
    expect(cloudUsageText(usage(51 * MIB), POLICY.account.storageBytes)).toBe('51.0 MB / 50 MB');
  });

  it('writes the decimal the way the language does', () => {
    getChromeFake().setUiLanguage('es');
    expect(cloudUsageText(usage(Math.round(12.3 * MIB)), POLICY.account.storageBytes)).toMatch(
      /^12,3 MB \/ 50 MB$/,
    );
  });
});

it('prefers the reading of the feed to that of me', () => {
  expect(preferredUsage(usage(1), usage(2))).toEqual(usage(1));
  expect(preferredUsage(null, usage(2))).toEqual(usage(2));
  expect(preferredUsage(null, null)).toBeNull();
});
