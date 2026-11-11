/**
 * Chrome Web Store registration preparation script.
 *
 * Runs the visual-asset pipeline (used as a release-it before:bump hook):
 *   1. Build the extension
 *   2. Launch Chrome with the built extension
 *   3. Generate Settings screenshots (1280x800)
 *   4. Generate Sessions dashboard screenshots (1280x800)
 *   5. Render the CWS promotional images
 *
 * Each step can be skipped by its flag. The process still exits 0 when only optional steps were
 * skipped, and exits 1 only when a step that should have worked did not.
 *
 * Environment flags (all `=1` to enable):
 *   SKIP_BUILD      don't run `pnpm build` (reuse whatever is in dist/)
 *   SKIP_OPTIONS    skip the Settings screenshots
 *   SKIP_DASHBOARD  skip the Sessions dashboard screenshots
 *   SKIP_PROMO      skip the promotional images
 *   HEADLESS=1      force a headless browser (the default where there is no display)
 *   PW_CHROMIUM     Chromium binary to drive (see scripts/e2e/browser.ts)
 *
 * Store screenshots per UI language:
 *   LOCALES=en,ko,es,ja   the languages to shoot (default `en`). Each gets its own browser,
 *                   started with `--lang=<code>` and LANGUAGE/LANG set (plus `-AppleLanguages`
 *                   on macOS, where Chrome ignores `--lang`), so `chrome.i18n` picks that
 *                   language; the run fails a language whose browser reports another one. English
 *                   runs every step into `assets/` under today's file names; every
 *                   other language only shoots the Settings and dashboard screenshots (steps 3-4),
 *                   with the fixture session names in that language, into `assets/<code>/`.
 *                   The promo images carry English text and are shared.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';

import type { Session } from '../src/types';
import { type ExtensionSession, launchExtension } from './e2e/browser';
import { buildDashboardFixtures, seedSessions } from './e2e/fixtures';
import {
  DEFAULT_LISTING_LOCALE,
  isListingLocale,
  LISTING_LOCALES,
  type ListingLocale,
  readLocaleMessage,
} from './store-listing';

/*
 * Types
 */

interface SkipRecord {
  step: string;
  reason: string;
}

/** Where one language's screenshots go and how to read the UI text they look for. */
interface CaptureTarget {
  locale: ListingLocale;
  /** `assets/` for English, `assets/<code>/` for the others. */
  dir: string;
  /** A message of the built extension in this language, `$1`.. filled in. */
  text: (key: string, ...substitutions: (string | number)[]) => string;
}

/*
 * Constants
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/**
 * The screenshots' build, out of sight and never dist/: it is built in the `store-screenshots`
 * mode, which turns Google sign-in on in an unpacked copy (see canSignInHere), and dist/ is what
 * the owner loads unpacked next to the store item, where that button can only fail.
 */
const DIST = path.join(ROOT, 'node_modules', '.cache', 'tabinet', 'store-screenshots');
const ASSETS_DIR = path.join(ROOT, 'assets');
const PROMO_TEMPLATE = path.join(__dirname, 'promo-template.html');
const ICON_PATH = path.join(ROOT, 'public', 'img', 'logo-128.png');

/** How long a dashboard control is waited for before its screenshot is skipped. */
const CONTROL_TIMEOUT = 8000;

/**
 * The fixture sessions' names and group titles as a person using that language would have typed
 * them; they show in the sidebar and the session view, so they are part of the screenshot. Keyed by
 * the English text in `scripts/e2e/fixtures.ts`; anything not listed stays English (tab titles
 * are web page titles, which stay as the sites wrote them).
 */
const FIXTURE_TEXT: Record<Exclude<ListingLocale, 'en'>, Record<string, string>> = {
  ko: {
    'Work - Monday morning': '업무 - 월요일 아침',
    'Research - everything open': '리서치 - 열려 있던 전부',
    'Snapshot - 40 minutes ago': '스냅샷 - 40분 전',
    'Snapshot - 2 hours ago': '스냅샷 - 2시간 전',
    'Recovered - before the crash': '복구됨 - 종료되기 전',
    Review: '리뷰',
    Docs: '문서',
    Reading: '읽을거리',
    'Prior art': '선행 사례',
    Specs: '명세',
    Benchmarks: '벤치마크',
    'Inbox zero': '받은편지함 비우기',
  },
  es: {
    'Work - Monday morning': 'Trabajo - lunes por la mañana',
    'Research - everything open': 'Investigación - todo lo abierto',
    'Snapshot - 40 minutes ago': 'Instantánea - hace 40 minutos',
    'Snapshot - 2 hours ago': 'Instantánea - hace 2 horas',
    'Recovered - before the crash': 'Recuperada - antes del cierre',
    Review: 'Revisión',
    Docs: 'Documentos',
    Reading: 'Lectura',
    'Prior art': 'Antecedentes',
    Specs: 'Especificaciones',
    Benchmarks: 'Pruebas de rendimiento',
    'Inbox zero': 'Bandeja vacía',
  },
  ja: {
    'Work - Monday morning': '仕事 - 月曜の朝',
    'Research - everything open': '調査 - 開いていたもの全部',
    'Snapshot - 40 minutes ago': 'スナップショット - 40 分前',
    'Snapshot - 2 hours ago': 'スナップショット - 2 時間前',
    'Recovered - before the crash': '復旧 - クラッシュ前',
    Review: 'レビュー',
    Docs: 'ドキュメント',
    Reading: '読み物',
    'Prior art': '先行事例',
    Specs: '仕様',
    Benchmarks: 'ベンチマーク',
    'Inbox zero': '受信トレイ整理',
  },
};

/*
 * Helpers
 */

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

/** `LOCALES=en,ko` → `['en', 'ko']`; unset means English only. Unknown codes stop the run. */
function requestedLocales(): ListingLocale[] {
  const raw = process.env.LOCALES;
  if (raw === undefined || raw.trim() === '') {
    return [DEFAULT_LISTING_LOCALE];
  }
  const codes = raw
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code !== '');
  const unknown = codes.filter((code) => !isListingLocale(code));
  if (unknown.length > 0) {
    throw new Error(
      `LOCALES has ${unknown.join(', ')}; the listing has ${LISTING_LOCALES.join(', ')}`,
    );
  }
  return LISTING_LOCALES.filter((code) => codes.includes(code));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A message of the built extension, the way `chrome.i18n.getMessage` fills it in: `$1`..`$9`
 * from `substitutions`, `$$` a literal dollar sign; English when the language lacks the key.
 */
function builtMessage(
  locale: ListingLocale,
  key: string,
  substitutions: (string | number)[],
): string {
  const localesDir = path.join(DIST, '_locales');
  const message =
    readLocaleMessage(localesDir, locale, key) ??
    readLocaleMessage(localesDir, DEFAULT_LISTING_LOCALE, key);
  if (message === undefined) {
    throw new Error(`dist/_locales has no message "${key}"`);
  }
  return message.replace(/\$(\$|[1-9])/g, (_whole, mark: string) =>
    mark === '$' ? '$' : String(substitutions[Number(mark) - 1] ?? ''),
  );
}

function captureTarget(locale: ListingLocale): CaptureTarget {
  return {
    locale,
    dir: locale === DEFAULT_LISTING_LOCALE ? ASSETS_DIR : path.join(ASSETS_DIR, locale),
    text: (key, ...substitutions) => builtMessage(locale, key, substitutions),
  };
}

/** The fixture sessions with their names and group titles in `locale`. */
function localizeFixtures(sessions: Session[], locale: ListingLocale): Session[] {
  if (locale === 'en') {
    return sessions;
  }
  const table = FIXTURE_TEXT[locale];
  const tr = (text: string): string => table[text] ?? text;
  return sessions.map((session) => ({
    ...session,
    name: tr(session.name),
    windows: session.windows.map((window) => ({
      ...window,
      groups: window.groups.map((group) => ({ ...group, title: tr(group.title) })),
    })),
  }));
}

/*
 * Entry point
 */

async function main(): Promise<void> {
  await new Preparation().run();
}

class Preparation {
  private context: ExtensionSession['context'] | null = null;
  private ext: ExtensionSession | null = null;
  private extensionId = '';
  private screenshotPage: Page | null = null;
  private readonly skipped: SkipRecord[] = [];
  private readonly failed: SkipRecord[] = [];
  private readonly locales = requestedLocales();

  constructor() {
    mkdirSync(ASSETS_DIR, { recursive: true });
  }

  /* Main runner */

  async run(): Promise<void> {
    // Step 1: Build
    this.buildExtension();

    if (this.locales.includes(DEFAULT_LISTING_LOCALE)) {
      await this.runEnglish();
    }
    // Other languages: Settings and dashboard only, each in a browser of its own.
    for (const locale of this.locales) {
      if (locale !== DEFAULT_LISTING_LOCALE) {
        await this.captureLocale(locale);
      }
    }

    this.report();
  }

  /** English: Settings, dashboard and promo images into `assets/`. */
  private async runEnglish(): Promise<void> {
    const target = captureTarget(DEFAULT_LISTING_LOCALE);

    // Step 2: Launch browser
    await this.launchBrowser();
    const languageOk = await this.checkUiLanguage(target.locale);

    if (languageOk) {
      // Step 3: Settings screenshots
      await this.takeOptionsScreenshots(target);

      // Step 4: Sessions dashboard screenshots
      await this.takeDashboardScreenshots(target);
    }

    // Step 5: Promo images
    await this.generatePromoImages();
    await this.context?.close();
  }

  /** Steps 3-4 in a browser whose UI language is `locale`, into `assets/<locale>/`. */
  private async captureLocale(locale: ListingLocale): Promise<void> {
    Preparation.step(`Store screenshots in ${locale}`);
    const target = captureTarget(locale);
    mkdirSync(target.dir, { recursive: true });
    await this.launchBrowser(locale);
    if (await this.checkUiLanguage(locale)) {
      await this.takeOptionsScreenshots(target);
      await this.takeDashboardScreenshots(target);
    }
    await this.context?.close();
    this.context = null;
    this.ext = null;
    this.screenshotPage = null;
  }

  /**
   * True when the extension really runs in `locale`. A browser that ignored the language switches
   * would shoot English screenshots into another language's folder, so that counts as a failure.
   */
  private async checkUiLanguage(locale: ListingLocale): Promise<boolean> {
    if (!this.ext) {
      return false;
    }
    const worker = await this.ext.worker();
    const uiLanguage = await worker.evaluate(() => chrome.i18n.getUILanguage());
    if (uiLanguage.toLowerCase().split(/[-_]/)[0] !== locale) {
      this.fail(
        `screenshots (${locale})`,
        `the browser's UI language is ${uiLanguage}, not ${locale}; its screenshots were not taken`,
      );
      return false;
    }
    console.log(`  UI language: ${uiLanguage}`);
    return true;
  }

  /* Skip / failure bookkeeping */

  private skip(step: string, reason: string): void {
    this.skipped.push({ step, reason });
    console.warn(`  SKIPPED - ${step}: ${reason}`);
  }

  private fail(step: string, reason: string): void {
    this.failed.push({ step, reason });
    console.error(`  FAILED - ${step}: ${reason}`);
  }

  private report(): void {
    console.log(`\n${'='.repeat(50)}`);
    if (this.skipped.length > 0) {
      console.log(`  ${this.skipped.length} optional step(s) skipped:`);
      for (const entry of this.skipped) {
        console.log(`    - ${entry.step}: ${entry.reason}`);
      }
    }
    if (this.failed.length > 0) {
      console.log(`  ${this.failed.length} step(s) FAILED:`);
      for (const entry of this.failed) {
        console.log(`    - ${entry.step}: ${entry.reason}`);
      }
      console.log('='.repeat(50));
      process.exitCode = 1;
      return;
    }
    console.log('='.repeat(50));
    console.log('\nDone! Screenshots and promo images regenerated.');
    process.exitCode = 0;
  }

  private static step(label: string): void {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  ${label}`);
    console.log('='.repeat(50));
  }

  private static errorMessage(err: unknown): string {
    return err instanceof Error ? err.message.split('\n')[0] : String(err);
  }

  /** True once the locator is visible; false (rather than throwing) when it never shows up. */
  private static async isVisible(locator: Locator, timeout = CONTROL_TIMEOUT): Promise<boolean> {
    try {
      await locator.first().waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  /* Pipeline steps */

  private buildExtension(): void {
    Preparation.step('1/5  Building extension');
    if (envFlag('SKIP_BUILD')) {
      this.skip('1/5  Building extension', 'SKIP_BUILD=1');
      if (!existsSync(path.join(DIST, 'manifest.json'))) {
        this.fail('1/5  Building extension', `SKIP_BUILD=1 but there is no build in ${DIST}`);
      }
      return;
    }
    // `store-screenshots`: an unpacked copy that shows Settings as the store build does (Google
    // sign-in available, see canSignInHere), built into DIST and never into dist/. The CLI's
    // --outDir is relative to Vite's root, src/.
    execSync(`pnpm build --mode store-screenshots --outDir ${JSON.stringify(DIST)}`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log('Build complete.');
  }

  private async launchBrowser(locale: ListingLocale = DEFAULT_LISTING_LOCALE): Promise<void> {
    Preparation.step(`2/5  Launching browser for screenshots (${locale})`);
    const session = await launchExtension({
      dist: DIST,
      preferHeaded: true,
      locale,
    }).catch((err: unknown) => {
      console.error('Could not launch Chrome with the extension:', Preparation.errorMessage(err));
      process.exit(1);
    });

    this.ext = session;
    this.context = session.context;
    this.extensionId = session.extensionId;
    console.log(`Extension ID: ${this.extensionId}`);
  }

  private async takeOptionsScreenshots(target: CaptureTarget): Promise<void> {
    if (!this.context) {
      return;
    }
    Preparation.step(`3/5  Settings screenshots (${target.locale})`);
    if (envFlag('SKIP_OPTIONS')) {
      this.skip('3/5  Settings screenshots', 'SKIP_OPTIONS=1');
      return;
    }
    const optionsUrl = `chrome-extension://${this.extensionId}/app.html#settings`;

    for (const { width, height } of [{ width: 1280, height: 800 }]) {
      const page = await this.context.newPage();
      await page.setViewportSize({ width, height });
      await page.goto(optionsUrl);
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('main', { timeout: 5000 });
      await page.waitForTimeout(500);

      const filepath = path.join(target.dir, `screenshot-${width}x${height}.png`);
      await page.screenshot({ path: filepath, fullPage: false });
      console.log(`  Saved: ${filepath}`);
      await page.close();
    }
  }

  /**
   * Sessions dashboard screenshots. The data comes from `scripts/e2e/fixtures.ts`, written
   * straight into `chrome.storage.local` through the extension service worker -- no Chrome
   * runtime ids are ever stored, so the records are exactly what a real save would leave behind.
   *
   * Every capture finds its control by role or accessible name and skips itself with a warning
   * when that control is missing, so this step never fails a release run.
   */
  private async takeDashboardScreenshots(target: CaptureTarget): Promise<void> {
    if (!this.context || !this.ext) {
      return;
    }
    const { text } = target;
    Preparation.step(`4/5  Sessions dashboard screenshots (${target.locale})`);
    if (envFlag('SKIP_DASHBOARD')) {
      this.skip('4/5  Sessions dashboard screenshots', 'SKIP_DASHBOARD=1');
      return;
    }

    const fixtures = localizeFixtures(buildDashboardFixtures(), target.locale);
    const worker = await this.ext.worker();
    await seedSessions(worker, fixtures);

    const dashboardUrl = `chrome-extension://${this.extensionId}/app.html`;
    const page = await this.context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    const reload = async (): Promise<void> => {
      await page.goto(dashboardUrl);
      await page.waitForLoadState('networkidle');
      await page
        .locator('main')
        .getByRole('heading', { name: text('openHeading') })
        .waitFor({
          timeout: CONTROL_TIMEOUT,
        });
      await page.waitForTimeout(300);
    };

    const shot = async (name: string, prepare: () => Promise<string | null>): Promise<void> => {
      try {
        await reload();
        const problem = await prepare();
        if (problem !== null) {
          this.skip(`dashboard-${name}.png`, problem);
          return;
        }
        await page.waitForTimeout(400);
        const filepath = path.join(target.dir, `dashboard-${name}.png`);
        await page.screenshot({ path: filepath, clip: { x: 0, y: 0, width: 1280, height: 800 } });
        console.log(`  Saved: ${path.relative(ROOT, filepath)}`);
      } catch (err) {
        this.skip(`dashboard-${name}.png`, Preparation.errorMessage(err));
      }
    };

    /**
     * The sidebar entry for a session; clicking it puts that session in the main pane. The rows are
     * links since they got addresses (SidebarNav's NavItem), not buttons.
     */
    const sidebarEntry = (name: string): Locator =>
      page
        .getByRole('navigation', { name: text('appNavLabel') })
        .locator('li a')
        .filter({
          hasText: name,
        });

    const openSession = async (name: string): Promise<string | null> => {
      const entry = sidebarEntry(name);
      if (!(await Preparation.isVisible(entry))) {
        return `no sidebar entry for “${name}”`;
      }
      await entry.first().click();
      await page
        .locator('main')
        .getByRole('heading', { name: text('treeWindowLabel', 1) })
        .first()
        .waitFor({ timeout: CONTROL_TIMEOUT });
      return null;
    };

    await shot('sessions', () => openSession(fixtures[0].name));

    await shot('restore', async () => {
      // The confirm dialog only appears above the large-restore threshold, which the second
      // fixture session is built to cross. If the click starts a restore instead, cancel it at
      // once rather than letting a screenshot run open a hundred tabs.
      const missing = await openSession(fixtures[1].name);
      if (missing !== null) {
        return missing;
      }
      const open = page
        .locator('main')
        .getByRole('button', { name: text('commonOpen'), exact: true });
      if (!(await Preparation.isVisible(open))) {
        return 'no Open control on the session view';
      }
      await open.first().click();

      const dialog = page.getByRole('dialog');
      const cancelRunning = page
        .getByRole('button', {
          name: new RegExp(
            `^(${escapeRegExp(text('restoreCancelling'))}|${escapeRegExp(text('commonCancel'))})`,
          ),
        })
        .and(page.locator('output button'));
      if (await Preparation.isVisible(cancelRunning, 2000)) {
        await cancelRunning
          .first()
          .click()
          .catch(() => undefined);
        return 'clicking Open started the restore directly (no confirm dialog)';
      }
      if (!(await Preparation.isVisible(dialog))) {
        return 'the restore confirm dialog did not open';
      }
      return null;
    });

    await shot('search', async () => {
      const search = page
        .getByRole('searchbox')
        .or(page.getByRole('textbox', { name: /search|filter/i }))
        .or(page.getByPlaceholder(/search|filter/i))
        .or(page.getByPlaceholder(text('searchPlaceholder')));
      if (!(await Preparation.isVisible(search))) {
        return 'no search field on the dashboard';
      }
      await search.first().fill('github');
      await page.waitForTimeout(500);
      return null;
    });

    await shot('history', async () => {
      // The snapshots live folded in the sidebar; open them and show the newest one. The fold is
      // the sidebar's only button with aria-expanded; its name is its count ("3 snapshots") and
      // show/hide is only its title, so it is found by the attribute, the same in every language.
      const toggle = page
        .getByRole('navigation', { name: text('appNavLabel') })
        .locator('button[aria-expanded]');
      if (!(await Preparation.isVisible(toggle))) {
        return 'no snapshots control in the sidebar';
      }
      if ((await toggle.first().getAttribute('aria-expanded')) === 'false') {
        await toggle.first().click();
        await page.waitForTimeout(300);
      }
      const snapshot = page
        .getByRole('navigation', { name: text('appNavLabel') })
        .locator('li a')
        .last();
      if (!(await Preparation.isVisible(snapshot))) {
        return 'no snapshot to show';
      }
      await snapshot.click();
      await page.waitForTimeout(400);
      return null;
    });

    await page.close();
  }

  /** The page promo images are rendered on; created lazily. */
  private async ensureScreenshotPage(): Promise<Page | null> {
    if (this.screenshotPage) {
      return this.screenshotPage;
    }
    if (!this.context) {
      return null;
    }
    this.screenshotPage = await this.context.newPage();
    await this.screenshotPage.setViewportSize({ width: 1280, height: 800 });
    return this.screenshotPage;
  }

  private async generatePromoImages(): Promise<void> {
    Preparation.step('5/5  Promotional images');
    if (envFlag('SKIP_PROMO')) {
      this.skip('5/5  Promotional images', 'SKIP_PROMO=1');
      return;
    }
    const page = await this.ensureScreenshotPage();
    if (page === null) {
      return;
    }
    console.log('  Generating promotional images...');

    const promoSizes = [
      { width: 440, height: 280, name: 'promo-small-440x280', titleSize: 28, descSize: 14 },
      { width: 1400, height: 560, name: 'promo-marquee-1400x560', titleSize: 48, descSize: 20 },
    ];

    const promoTemplate = readFileSync(PROMO_TEMPLATE, 'utf-8');

    for (const { width, height, name, titleSize, descSize } of promoSizes) {
      const html = promoTemplate
        .replace('{{WIDTH}}', String(width))
        .replace('{{HEIGHT}}', String(height))
        .replace('{{TITLE_SIZE}}', String(titleSize))
        .replace('{{DESC_SIZE}}', String(descSize))
        .replace('{{ICON_PATH}}', `file://${ICON_PATH}`);

      const htmlPath = path.join(ASSETS_DIR, `${name}.html`);
      writeFileSync(htmlPath, html);

      await page.setViewportSize({ width, height });
      await page.goto(`file://${htmlPath}`);
      await page.waitForTimeout(500);

      const filepath = path.join(ASSETS_DIR, `${name}.png`);
      await page.screenshot({
        path: filepath,
        clip: { x: 0, y: 0, width, height },
      });
      console.log(`  Saved: ${name}.png`);
    }
  }
}

main().catch((err: unknown) => {
  console.error('prepare-registration failed:', err);
  process.exitCode = 1;
});
