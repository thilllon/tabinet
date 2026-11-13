/**
 * Where `chrome.storage.local` keeps this extension's data on disk, for the line under the
 * storage meter. Chrome writes it as a LevelDB database in the profile folder, under
 * `Local Extension Settings/<extension id>/`.
 *
 * An extension cannot read the profile path, and the folder name of the profile is not known
 * here: the path is built for Chrome's first profile, `Default`, on the usual install for this
 * OS. chrome://version shows the exact Profile Path (another profile, Beta, Canary, Chromium),
 * so the meter also has a button that opens it.
 */

import { joinSentences, t } from '@/lib/i18n';

export type StorageOs = 'mac' | 'windows' | 'linux';

/** The folder name of Chrome's first profile, which is the profile most people have. */
export const DEFAULT_PROFILE = 'Default';

/** Chrome's own page that shows the exact Profile Path. */
export const CHROME_VERSION_URL = 'chrome://version';

/**
 * The OS from a platform string: `navigator.userAgentData.platform` ("macOS", "Windows",
 * "Linux", "Chrome OS") or `navigator.platform` ("MacIntel", "Win32", "Linux x86_64").
 * ChromeOS and anything unknown come back `undefined`: there the folder is not one a person
 * can open, so no path is shown.
 */
export function storageOsOf(platform: string): StorageOs | undefined {
  const p = platform.toLowerCase();
  if (p.includes('mac')) {
    return 'mac';
  }
  if (p.includes('win')) {
    return 'windows';
  }
  if (p.includes('cros') || p.includes('chrome os') || p.includes('android')) {
    return undefined;
  }
  if (p.includes('linux')) {
    return 'linux';
  }
  return undefined;
}

/** The folder holding this extension's `chrome.storage.local` database, for one OS. */
export function storageFolderPath(
  os: StorageOs,
  extensionId: string,
  profile: string = DEFAULT_PROFILE,
): string {
  switch (os) {
    case 'mac':
      return `~/Library/Application Support/Google/Chrome/${profile}/Local Extension Settings/${extensionId}`;
    case 'windows':
      return `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\${profile}\\Local Extension Settings\\${extensionId}`;
    case 'linux':
      return `~/.config/google-chrome/${profile}/Local Extension Settings/${extensionId}`;
  }
}

interface PlatformSource {
  userAgentData?: { platform?: unknown };
  platform?: unknown;
}

/** The platform string of this browser: the client hint when there is one, else the old field. */
export function platformOf(nav: PlatformSource): string {
  const hinted = nav.userAgentData?.platform;
  if (typeof hinted === 'string' && hinted !== '') {
    return hinted;
  }
  return typeof nav.platform === 'string' ? nav.platform : '';
}

/** The OS and folder on this device, or `undefined` where there is none to show. */
export function thisStorageFolder(): { os: StorageOs; path: string } | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const os = storageOsOf(platformOf(navigator as PlatformSource));
  return os === undefined ? undefined : { os, path: storageFolderPath(os, chrome.runtime.id) };
}

/** The grey lines under the path: how to open it on this OS, and that the files are not readable. */
export function storageFolderHint(os: StorageOs): string {
  const howToOpen = {
    mac: t('storageLocationHintMac'),
    windows: t('storageLocationHintWindows'),
    linux: t('storageLocationHintLinux'),
  }[os];
  return joinSentences(howToOpen, t('storageLocationNotReadable'));
}

export async function openChromeVersion(): Promise<void> {
  await chrome.tabs.create({ url: CHROME_VERSION_URL });
}
