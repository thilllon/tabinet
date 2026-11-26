import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { type Browser, chromium } from '@playwright/test';

/**
 * A headless Chromium for the icon and screenshot scripts; never a visible window. `PW_CHROMIUM`
 * names a binary; otherwise the newest Chrome for Testing in Playwright's cache is used, and
 * failing that Playwright's own `chromium` channel (full Chromium in new headless mode).
 */
function findChromium(): string | undefined {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) {
    return undefined;
  }
  const builds = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64']) {
      const binary = path.join(
        cache,
        build,
        arch,
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      );
      if (existsSync(binary)) {
        return binary;
      }
    }
  }
  return undefined;
}

/** Which Chromium to start: a found binary, else Playwright's `chromium` channel. */
export function chromiumBinary(): { executablePath: string } | { channel: 'chromium' } {
  const executablePath = findChromium();
  return executablePath === undefined ? { channel: 'chromium' } : { executablePath };
}

export async function launchHeadless(): Promise<Browser> {
  return chromium.launch({ headless: true, ...chromiumBinary() });
}
