import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorDetail,
  errorMessage,
  ExplainedError,
  knownErrorText,
  LocalizedError,
  reportError,
} from '@/lib/error-message';
import { t } from '@/lib/i18n';
import { pickWindow } from '@/lib/session-list';
import {
  MalformedRecordError,
  migrateIndex,
  UnknownSchemaVersionError,
} from '@/lib/session-migrate';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorMessage', () => {
  it('shows a message made with t() as it is', () => {
    expect(errorMessage(new LocalizedError(t('storageSessionNotFound', 'abc')))).toBe(
      t('storageSessionNotFound', 'abc'),
    );
  });

  it('never shows an English developer message: unknown errors get the generic sentence', () => {
    expect(errorMessage(new Error('Invariant violated: groupIndex out of range'))).toBe(
      t('errorGeneric'),
    );
    expect(errorMessage(new TypeError('update() must not change the session id'))).toBe(
      t('errorGeneric'),
    );
    expect(errorMessage('plain')).toBe(t('errorGeneric'));
    expect(errorMessage(42)).toBe(t('errorGeneric'));
    expect(errorMessage(new Error(''))).toBe(t('errorGeneric'));
  });

  it('falls back to "Unknown error" when there is nothing at all', () => {
    expect(errorMessage(undefined)).toBe('Unknown error');
    expect(errorMessage(null)).toBe('Unknown error');
  });

  it('explains the internal errors that can reach the page', () => {
    // session-edit / session-list / session-export: an index the page still showed is gone.
    let rangeError: unknown;
    try {
      pickWindow({ windows: [] } as unknown as Parameters<typeof pickWindow>[0], 3);
    } catch (err) {
      rangeError = err;
    }
    expect(rangeError).toBeInstanceOf(RangeError);
    expect(errorMessage(rangeError)).toBe(t('errorSessionChanged'));
    // session-restore: windows.create gave nothing back.
    expect(
      errorMessage(new ExplainedError('windows.create returned no window', 'errorRestoreNoWindow')),
    ).toBe(t('errorRestoreNoWindow'));
    // session-migrate: a damaged record and one from a newer version.
    let malformed: unknown;
    try {
      migrateIndex(42);
    } catch (err) {
      malformed = err;
    }
    expect(malformed).toBeInstanceOf(MalformedRecordError);
    expect(errorMessage(malformed)).toBe(t('errorDataUnreadable'));
    expect(errorMessage(new UnknownSchemaVersionError(9))).toBe(t('errorDataTooNew'));
  });

  it("words Chrome's own English errors in the UI language", () => {
    expect(
      errorMessage(new Error('Tabs cannot be edited right now (user may be dragging a tab).')),
    ).toBe(t('errorTabsBusy'));
    expect(errorMessage(new Error('No tab with id: 12.'))).toBe(t('errorTabGone'));
    expect(errorMessage(new Error('No window with id: 3.'))).toBe(t('errorTabGone'));
    expect(errorMessage(new Error('Invalid value for bounds'))).toBe(t('errorWindowBounds'));
    expect(errorMessage(new Error('Resource::kQuotaBytes quota exceeded'))).toBe(
      t('storageQuotaNotice'),
    );
    expect(errorMessage(new DOMException('Document is not focused.', 'NotAllowedError'))).toBe(
      t('errorNotAllowed'),
    );
  });
});

describe('knownErrorText', () => {
  it('is undefined for an error it cannot explain, so a caller can word its line without one', () => {
    expect(knownErrorText(new Error('boom'))).toBeUndefined();
    expect(knownErrorText('NotReadableError')).toBeUndefined();
    expect(knownErrorText('windows.create returned no window')).toBe(t('errorRestoreNoWindow'));
  });
});

describe('errorDetail / reportError', () => {
  it('keeps the original for the console', () => {
    expect(errorDetail(new RangeError('No window at index 3'))).toBe(
      'RangeError: No window at index 3',
    );
    expect(errorDetail('plain')).toBe('plain');
  });

  it('logs the original and returns the localized sentence', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('Invariant violated: more than one active tab');
    expect(reportError('restore', err)).toBe(t('errorGeneric'));
    expect(errorSpy).toHaveBeenCalledWith('[tabinet] restore', err);
  });
});
