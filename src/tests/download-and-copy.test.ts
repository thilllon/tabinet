import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clipboardUnavailableMessage,
  copyFailureMessage,
  copyText,
  downloadDescriptor,
} from '@/lib/download-and-copy';

const DATE = new Date(2026, 7, 29, 14, 3);

/** Installs a fake `navigator.clipboard` for one test; the property is removed afterwards. */
function stubClipboard(writeText: unknown): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('downloadDescriptor', () => {
  it('names the file after the session and the format', () => {
    expect(downloadDescriptor('Work stuff', 'json', DATE)).toEqual({
      filename: 'tabinet-work-stuff-20260829-1403.json',
      mimeType: 'application/json',
    });
  });

  it('drops a name that slugifies to nothing', () => {
    expect(downloadDescriptor('!!!', 'csv', DATE).filename).toBe('tabinet-20260829-1403.csv');
  });
});

describe('copyText', () => {
  it('writes to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    await expect(copyText('https://a.test/')).resolves.toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('https://a.test/');
  });

  it('reports a rejected write instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubClipboard(vi.fn().mockRejectedValue(new Error('Document is not focused')));
    await expect(copyText('x')).resolves.toEqual({
      ok: false,
      error: 'Could not copy to the clipboard.',
    });
  });

  it('reports a missing clipboard API', async () => {
    stubClipboard(undefined);
    await expect(copyText('x')).resolves.toEqual({
      ok: false,
      error: clipboardUnavailableMessage(),
    });
  });
});

describe('copyFailureMessage', () => {
  it('gives the reason in the UI language, or none when the browser said something it cannot translate', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      copyFailureMessage(new DOMException('Document is not focused.', 'NotAllowedError')),
    ).toBe('Could not copy to the clipboard: The browser did not allow this.');
    expect(copyFailureMessage('nope')).toBe('Could not copy to the clipboard.');
    expect(copyFailureMessage(undefined)).toBe('Could not copy to the clipboard.');
  });
});
