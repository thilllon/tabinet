import { describe, expect, it } from 'vitest';

import {
  CHROME_VERSION_URL,
  openChromeVersion,
  platformOf,
  storageFolderHint,
  storageFolderPath,
  storageOsOf,
} from '@/lib/storage-location';
import { getChromeFake } from '@/tests/chrome-fake';

const ID = 'bmbpmnfhfbdjdjpblimidmbohgccmjdg';

describe('storageOsOf', () => {
  it('reads the client hint names', () => {
    expect(storageOsOf('macOS')).toBe('mac');
    expect(storageOsOf('Windows')).toBe('windows');
    expect(storageOsOf('Linux')).toBe('linux');
    expect(storageOsOf('Chrome OS')).toBeUndefined();
  });

  it('reads navigator.platform values', () => {
    expect(storageOsOf('MacIntel')).toBe('mac');
    expect(storageOsOf('Win32')).toBe('windows');
    expect(storageOsOf('Linux x86_64')).toBe('linux');
  });

  it('gives nothing for an unknown or empty platform', () => {
    expect(storageOsOf('')).toBeUndefined();
    expect(storageOsOf('iPhone')).toBeUndefined();
  });
});

describe('storageFolderPath', () => {
  it('builds the macOS folder', () => {
    expect(storageFolderPath('mac', ID)).toBe(
      `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/${ID}`,
    );
  });

  it('builds the Windows folder with backslashes', () => {
    expect(storageFolderPath('windows', ID)).toBe(
      `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Local Extension Settings\\${ID}`,
    );
  });

  it('builds the Linux folder', () => {
    expect(storageFolderPath('linux', ID)).toBe(
      `~/.config/google-chrome/Default/Local Extension Settings/${ID}`,
    );
  });

  it('takes another profile folder', () => {
    expect(storageFolderPath('linux', ID, 'Profile 2')).toBe(
      `~/.config/google-chrome/Profile 2/Local Extension Settings/${ID}`,
    );
  });
});

describe('platformOf', () => {
  it('prefers the client hint', () => {
    expect(platformOf({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe('macOS');
  });

  it('falls back to navigator.platform', () => {
    expect(platformOf({ platform: 'Win32' })).toBe('Win32');
    expect(platformOf({ userAgentData: { platform: '' }, platform: 'Linux x86_64' })).toBe(
      'Linux x86_64',
    );
    expect(platformOf({})).toBe('');
  });
});

describe('openChromeVersion', () => {
  it('opens chrome://version in a new tab', async () => {
    await openChromeVersion();
    expect(getChromeFake().state.createdTabs).toEqual([{ url: CHROME_VERSION_URL }]);
  });
});

describe('storageFolderHint', () => {
  it('says how to open the folder on each OS, then that the files are not readable', () => {
    expect(storageFolderHint('mac')).toContain('Cmd+Shift+G');
    expect(storageFolderHint('windows')).toContain('File Explorer');
    expect(storageFolderHint('linux')).toContain('Ctrl+L');
    for (const os of ['mac', 'windows', 'linux'] as const) {
      expect(storageFolderHint(os)).toContain('Backup > Export');
    }
  });
});
