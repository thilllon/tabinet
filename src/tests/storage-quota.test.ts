import { describe, expect, it } from 'vitest';

import { isQuotaError } from '@/lib/storage-quota';

describe('isQuotaError', () => {
  it('recognises the wording chrome.storage.local rejects with', () => {
    expect(isQuotaError(new Error('Resource::kQuotaBytes quota exceeded'))).toBe(true);
    expect(isQuotaError(new Error('QUOTA_BYTES quota exceeded'))).toBe(true);
    expect(isQuotaError(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'))).toBe(true);
  });

  it('recognises a bare string rejection', () => {
    expect(isQuotaError('QUOTA_BYTES quota exceeded')).toBe(true);
  });

  it('recognises a DOMException-shaped rejection by name', () => {
    expect(isQuotaError({ name: 'QuotaExceededError', message: '', code: 22 })).toBe(true);
    // Some builds only carry the legacy numeric code alongside a quota-ish name.
    expect(isQuotaError({ name: 'Quota exceeded', code: 22 })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isQuotaError(new Error('Storage is FULL'))).toBe(true);
    expect(isQuotaError(new Error('exceeded the Quota for this origin'))).toBe(true);
  });

  it('does not claim ordinary failures', () => {
    expect(isQuotaError(new Error('Session not found: id-a'))).toBe(false);
    expect(isQuotaError(new Error('Tabs cannot be edited right now'))).toBe(false);
    expect(isQuotaError(new TypeError('windows.create returned no window'))).toBe(false);
    expect(isQuotaError('network error')).toBe(false);
  });

  it('does not throw on nothing at all', () => {
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(42)).toBe(false);
    expect(isQuotaError({})).toBe(false);
    expect(isQuotaError({ name: 22, message: 22, code: 'x' })).toBe(false);
  });
});
