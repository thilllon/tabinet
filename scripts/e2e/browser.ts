/**
 * Launching a real Chrome with the built extension loaded, for QA and for release screenshots.
 *
 * Two environment facts this wraps:
 *  - Playwright's own pinned browser build is not always present. `PW_CHROMIUM` (default
 *    `/opt/pw-browsers/chromium`) points at a Chromium that is; when neither exists we fall back
 *    to Playwright's default resolution and let it report its own error.
 *  - Extensions do load in headless Chrome, so headless is the default anywhere without a
 *    display. `HEADLESS=0` forces a headed run (the sort and selection checks need one: sorting acts on the
 *    last-focused window).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { type BrowserContext, chromium, type Worker } from '@playwright/test';

import { SUPPORTED_LOCALES, type SupportedLocale } from '../../src/constants';

const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium';

/**
 * Absolute path to the Chromium binary to drive, or `undefined` to let Playwright resolve its
 * own pinned build. `PW_CHROMIUM` wins; otherwise the well-known sandbox path is used when it
 * exists.
 */
function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  return existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined;
}

/** Headless unless `HEADLESS=0`, or unless a display is available on Linux and `HEADLESS=1` is unset. */
function resolveHeadless(preferHeaded: boolean): boolean {
  const flag = process.env.HEADLESS;
  if (flag === '0' || flag === 'false') {
    return false;
  }
  if (flag === '1' || flag === 'true') {
    return true;
  }
  if (!preferHeaded) {
    return true;
  }
  // A headed run was asked for, but there is nothing to show it on.
  return process.platform === 'linux' && (process.env.DISPLAY ?? '') === '';
}

interface LaunchOptions {
  /** Absolute path to the built extension (the `dist/` directory). */
  dist: string;
  /** Extra Chrome switches, appended after the extension-loading ones. */
  args?: string[];
  /**
   * `true` when the caller would rather have a visible window (the sort and selection checks,
   * release screenshots).
   * Ignored when there is no display - see {@link resolveHeadless}.
   */
  preferHeaded?: boolean;
  /**
   * The Chrome UI language, which is also the language the extension's text is in (`chrome.i18n`).
   * Defaults to English so the harnesses that find elements by their text pass whatever language
   * the machine is set to.
   */
  locale?: string;
}

/**
 * POSIX locale for LANG/LANGUAGE, which Chromium on Linux reads before `--lang`. One per shipped
 * language (`SUPPORTED_LOCALES` in src/constants.ts), so a new language must add its own here.
 */
const POSIX_LOCALES: Record<SupportedLocale, string> = {
  en: 'en_US',
  ko: 'ko_KR',
  es: 'es_ES',
  ja: 'ja_JP',
};

/**
 * Chrome switches that make `chrome.i18n` answer in `locale`. Linux and Windows read `--lang`
 * (Linux also LANGUAGE/LANG, see {@link setLanguageEnv}); macOS ignores both (verified: Chrome for
 * Testing 156 still reports en-US) and takes the Cocoa `AppleLanguages` default instead, see
 * {@link pinMacLanguage}. Playwright refuses the `-AppleLanguages (ko)` argument pair outright.
 */
function languageArgs(locale: string): string[] {
  return [`--lang=${locale}`];
}

function posixLocale(locale: string): string {
  const shipped = SUPPORTED_LOCALES.find((code) => code === locale);
  return shipped === undefined ? locale : POSIX_LOCALES[shipped];
}

/** Sets LANGUAGE/LANG for `locale`; Playwright hands the browser this process's environment. */
function setLanguageEnv(locale: string): void {
  process.env.LANGUAGE = locale;
  process.env.LANG = `${posixLocale(locale)}.UTF-8`;
}

/** The Chrome for Testing bundle Playwright launches on macOS; its defaults domain is its own. */
const TEST_BROWSER_DOMAIN = 'com.google.chrome.for.testing';

/**
 * On macOS, sets the test browser's own `AppleLanguages` default to `locale` (never the owner's
 * Chrome: only the Chrome for Testing domain is written) and returns how to put it back. Elsewhere
 * it does nothing. Called around the launch only: Chrome reads the default once, at startup.
 */
function pinMacLanguage(locale: string): () => void {
  if (process.platform !== 'darwin') {
    return () => undefined;
  }
  let previous: string[] | undefined;
  try {
    // `defaults read` prints an array as "(\n    ko,\n    en\n)"; it fails when the key is unset.
    previous = execFileSync('defaults', ['read', TEST_BROWSER_DOMAIN, 'AppleLanguages'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .replace(/[()",]/g, ' ')
      .split(/\s+/)
      .filter((item) => item !== '');
  } catch {
    previous = undefined;
  }
  execFileSync('defaults', ['write', TEST_BROWSER_DOMAIN, 'AppleLanguages', '-array', locale]);
  return () => {
    if (previous === undefined) {
      execFileSync('defaults', ['delete', TEST_BROWSER_DOMAIN, 'AppleLanguages']);
    } else {
      execFileSync('defaults', [
        'write',
        TEST_BROWSER_DOMAIN,
        'AppleLanguages',
        '-array',
        ...previous,
      ]);
    }
  };
}

/** How long to wait for the extension service worker to register. */
const SERVICE_WORKER_TIMEOUT_MS = 15_000;

export interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  /**
   * The *current* service worker, with its extension API bindings confirmed present. Chrome may
   * terminate an idle MV3 worker and start a fresh one; the old `Worker` handle is then dead and
   * `evaluate` on it rejects. Always call this rather than caching the handle.
   */
  worker(): Promise<Worker>;
  /** `chrome-extension://<id>/<page>` */
  pageUrl(page: string): string;
  close(): Promise<void>;
}

async function firstServiceWorker(context: BrowserContext, timeout: number): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing !== undefined) {
    return existing;
  }
  return context.waitForEvent('serviceworker', { timeout: Math.max(timeout, 500) });
}

/**
 * `tsx` compiles with esbuild's `keepNames`, which rewrites every *named* inner function of an
 * `evaluate()` callback into `__name(fn, 'fn')`. That helper only exists in the Node bundle, so
 * the browser side throws `ReferenceError: __name is not defined`. Defining an identity `__name`
 * in the target context makes those callbacks work verbatim. Passed as a source string so esbuild
 * cannot rewrite the shim itself.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || function (fn) { return fn; };';

/** Installs the `__name` shim (see {@link NAME_SHIM}) into a worker or page context. */
export async function installNameShim(target: {
  evaluate(expression: string): Promise<unknown>;
}): Promise<void> {
  await target.evaluate(NAME_SHIM);
}

/**
 * The MV3 worker target shows up before Chrome has installed the extension API bindings into its
 * global scope: for a short window `chrome` there holds only the page-level `csi`/`loadTimes`, and
 * `chrome.windows.create` throws "Cannot read properties of undefined". Poll until the APIs this
 * tooling drives are actually there.
 */
async function workerWithApis(context: BrowserContext, timeout: number): Promise<Worker> {
  const deadline = Date.now() + timeout;
  let lastError = 'the extension service worker never exposed chrome.tabs / chrome.windows';
  for (;;) {
    const worker = await firstServiceWorker(context, deadline - Date.now());
    try {
      const ready = await worker.evaluate(() => {
        const api = (globalThis as unknown as { chrome?: Record<string, unknown> }).chrome;
        return (
          typeof api?.windows === 'object' &&
          typeof api?.tabs === 'object' &&
          typeof api?.tabGroups === 'object' &&
          typeof api?.storage === 'object'
        );
      });
      if (ready) {
        await installNameShim(worker);
        return worker;
      }
    } catch (err) {
      // The worker was replaced mid-poll (Chrome recycles idle MV3 workers); take the next one.
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(lastError);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Launches a persistent context with `dist/` loaded as an unpacked extension. */
export async function launchExtension(options: LaunchOptions): Promise<ExtensionSession> {
  const { dist, args = [], preferHeaded = false, locale = 'en' } = options;
  const executablePath = resolveChromiumExecutable();
  const headless = resolveHeadless(preferHeaded);
  setLanguageEnv(locale);
  // Chrome reads AppleLanguages once, at startup, so the default is put back as soon as it is up.
  const restoreMacLanguage = pinMacLanguage(locale);
  const context = await chromium
    .launchPersistentContext('', {
      ...(executablePath === undefined ? {} : { executablePath }),
      // Playwright's default headless browser is chromium-headless-shell, which cannot load an
      // extension; the `chromium` channel runs the full browser in its new headless mode instead.
      ...(executablePath === undefined && headless ? { channel: 'chromium' } : {}),
      headless,
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        ...languageArgs(locale),
        ...args,
      ],
    })
    .finally(restoreMacLanguage);

  const serviceWorker = await workerWithApis(context, SERVICE_WORKER_TIMEOUT_MS);
  const extensionId = serviceWorker.url().split('/')[2];

  return {
    context,
    extensionId,
    async worker(): Promise<Worker> {
      return workerWithApis(context, SERVICE_WORKER_TIMEOUT_MS);
    },
    pageUrl: (page: string) => `chrome-extension://${extensionId}/${page}`,
    close: () => context.close(),
  };
}
