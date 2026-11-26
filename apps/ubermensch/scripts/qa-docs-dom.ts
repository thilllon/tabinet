/**
 * Manual QA against the real editors, headless and signed out (never an account): opens Google's
 * public API sample files of Docs, Sheets and Slides, runs the built content script (dist/) in
 * them with a stub `chrome` that answers a fixture path, and checks that the path is mounted after
 * the title, that it comes back after Google re-renders the title bar, and that it renders the
 * fixture names. Also loads dist/ as an extension and opens its options page.
 *
 *   pnpm --filter ubermensch build && pnpm --filter ubermensch exec tsx scripts/qa-docs-dom.ts
 *
 * QA_SHOTS=<dir> writes a screenshot of each title bar there.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { chromiumBinary, launchHeadless } from './browser';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Google's own public samples from the Docs, Sheets and Slides API quickstarts. */
const SAMPLES = {
  document: 'https://docs.google.com/document/d/195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE/edit',
  spreadsheets:
    'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
  presentation:
    'https://docs.google.com/presentation/d/1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc/edit',
} as const;

const FIXTURE_ANSWER = {
  state: 'ready',
  path: {
    kind: 'path',
    partial: false,
    segments: [
      { id: 'root', name: '', kind: 'my-drive' },
      { id: 'f1', name: 'Fixture folder', kind: 'folder' },
    ],
  },
};

function readMessages(): Record<string, string> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(ROOT, 'public/_locales/en/messages.json'), 'utf8'),
  );
  const out: Record<string, string> = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [key, value] of Object.entries(parsed)) {
      const message: unknown =
        typeof value === 'object' && value !== null ? Reflect.get(value, 'message') : undefined;
      if (typeof message === 'string') {
        out[key] = message;
      }
    }
  }
  return out;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function checkEditors(): Promise<void> {
  const script = readFileSync(path.join(ROOT, 'dist/content-script.js'), 'utf8');
  const messages = readMessages();
  const browser = await launchHeadless();
  try {
    for (const [kind, url] of Object.entries(SAMPLES)) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 600 } });
      await page.addInitScript({ content: 'window.__name = (fn) => fn;' });
      await page.addInitScript(
        ({ catalog, answer }) => {
          const getMessage = (key: string, subs?: string | string[]): string => {
            const list = subs === undefined ? [] : typeof subs === 'string' ? [subs] : subs;
            return (catalog[key] ?? '').replace(
              /\$([1-9])/g,
              (_m, n: string) => list[Number(n) - 1] ?? '',
            );
          };
          Reflect.set(window, 'chrome', {
            i18n: { getMessage },
            runtime: { sendMessage: async () => answer },
          });
        },
        { catalog: messages, answer: FIXTURE_ANSWER },
      );
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('.docs-title-outer', { timeout: 30_000 });
      // Through the DevTools protocol, as Google's Trusted Types refuse a script element.
      await page.evaluate(script);
      const host = '[data-ubermensch="drive-path"]';
      await page.waitForSelector(host, { state: 'attached', timeout: 10_000 });
      const mounted = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        const text = element?.shadowRoot?.querySelector('.row')?.textContent ?? '';
        return { parent: element?.parentElement?.className ?? '', text };
      }, host);
      check(
        `${kind}: mounted in the title badges`,
        mounted.parent.includes('docs-titlebar-badges'),
        mounted.parent,
      );
      check(
        `${kind}: shows the fixture path`,
        mounted.text.includes('My Drive') && mounted.text.includes('Fixture folder'),
        mounted.text,
      );

      // Google re-renders the title row: replace it with a copy that lacks our element.
      await page.evaluate(() => {
        const badges = document.querySelector('.docs-titlebar-badges');
        if (badges !== null) {
          const copy = badges.cloneNode(true);
          if (copy instanceof Element) {
            copy.querySelector('[data-ubermensch]')?.remove();
          }
          badges.replaceWith(copy);
        }
      });
      const back = await page
        .waitForFunction(
          (selector) => document.querySelector(`.docs-titlebar-badges ${selector}`) !== null,
          host,
          { timeout: 5_000 },
        )
        .then(() => true)
        .catch(() => false);
      check(`${kind}: comes back after a re-render`, back);
      check(`${kind}: only one copy`, (await page.locator(host).count()) === 1);
      if (process.env.QA_SHOTS !== undefined) {
        await page.screenshot({
          path: path.join(process.env.QA_SHOTS, `qa-${kind}.png`),
          clip: { x: 0, y: 0, width: 1000, height: 70 },
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function checkExtension(): Promise<void> {
  const profile = mkdtempSync(path.join(tmpdir(), 'ubermensch-qa-'));
  const dist = path.join(ROOT, 'dist');
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...chromiumBinary(),
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const id = new URL(worker.url()).host;
    check(
      'extension: service worker started',
      worker.url().endsWith('/service-worker-loader.js'),
      worker.url(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.waitForSelector('[role="switch"]');
    const text = await page.locator('main').innerText();
    check(
      'extension: options page renders',
      text.includes('Access to Google Docs'),
      text.slice(0, 80),
    );
    check('extension: says sign-in is not configured', text.includes('not configured'));
    check('extension: no page errors', errors.length === 0, errors.join('; '));
    if (process.env.QA_SHOTS !== undefined) {
      await page.setViewportSize({ width: 900, height: 600 });
      await page.screenshot({ path: path.join(process.env.QA_SHOTS, 'qa-options.png') });
    }
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  await checkExtension();
  await checkEditors();
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

void main();
