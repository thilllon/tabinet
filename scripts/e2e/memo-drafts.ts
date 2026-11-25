/**
 * Real-Chrome check that memo text survives the page going away (spec 12.1): the editor leaves a
 * draft synchronously on `pagehide` and the worker adopts it, so closing the tab, reloading it or
 * navigating away within the autosave interval loses nothing; and a language change synced while
 * typing saves the text before the page reloads into the new language.
 *
 *   pnpm build && pnpm e2e:memo-drafts
 *
 * Headless by default. `MEMO_RUNS` (default 30) sets the runs per case. Results are read back
 * through `chrome.storage.local` in the extension's own service worker.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { type ExtensionSession, launchExtension } from './browser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');
const UI_TIMEOUT = 10_000;
const RUNS = Number.parseInt(process.env.MEMO_RUNS ?? '30', 10);

interface StoredMemo {
  id: string;
  text: string;
}

async function storedMemo(ext: ExtensionSession, id: string): Promise<StoredMemo | undefined> {
  const worker = await ext.worker();
  return worker.evaluate(async (key: string) => {
    const value = (await chrome.storage.local.get(key))[key] as StoredMemo | null | undefined;
    return value ?? undefined;
  }, `memo:${id}`);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + UI_TIMEOUT;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Seeds one memo straight into storage, through the extension's own page context. */
async function seedMemo(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ memoId, body }) => {
      const now = Date.now();
      await chrome.storage.local.set({
        [`memo:${memoId}`]: {
          schemaVersion: 1,
          id: memoId,
          text: body,
          createdAt: now,
          updatedAt: now,
        },
        memoIndex: {
          schemaVersion: 1,
          memos: [
            {
              id: memoId,
              title: body.slice(0, 20),
              createdAt: now,
              updatedAt: now,
              conflict: false,
            },
          ],
        },
      });
    },
    { memoId: id, body: text },
  );
}

async function openMemo(ext: ExtensionSession, id: string): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto(ext.pageUrl(`app.html#memo/${id}`));
  await page.getByRole('textbox', { name: 'Memo text' }).waitFor({ timeout: UI_TIMEOUT });
  return page;
}

type Leave = 'close' | 'reload' | 'navigate';

async function leave(page: Page, how: Leave): Promise<void> {
  if (how === 'close') {
    await page.close({ runBeforeUnload: true });
  } else if (how === 'reload') {
    await page.reload();
  } else {
    await page.goto('about:blank');
  }
}

const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await run() });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

async function main(): Promise<void> {
  const ext = await launchExtension({ dist: DIST });
  try {
    const home = await ext.context.newPage();
    await home.goto(ext.pageUrl('app.html'));
    await home.getByRole('heading', { name: 'Open tabs' }).waitFor({ timeout: UI_TIMEOUT });

    await check('a new memo is stored once it has text, and only then', async () => {
      const page = await ext.context.newPage();
      await page.goto(ext.pageUrl('app.html#memo/new'));
      const box = page.getByRole('textbox', { name: 'Memo text' });
      await box.waitFor({ timeout: UI_TIMEOUT });
      await box.pressSequentially('First line\nsecond');
      await page.waitForURL(
        (url) => /#memo\/[A-Za-z0-9_-]+$/.test(url.hash) && url.hash !== '#memo/new',
        {
          timeout: UI_TIMEOUT,
        },
      );
      const id = page.url().split('#memo/')[1] ?? '';
      const memo = await until(
        () => storedMemo(ext, id),
        (value) => value?.text === 'First line\nsecond',
      );
      if (memo?.text !== 'First line\nsecond') {
        throw new Error(`stored ${JSON.stringify(memo)}`);
      }
      await page.close();
      return `memo ${id}`;
    });

    await check('search finds a memo by its text, Enter opens it, Delete offers Undo', async () => {
      const page = await ext.context.newPage();
      await page.goto(ext.pageUrl('app.html'));
      const search = page.getByRole('textbox', { name: 'Search', exact: true });
      await search.waitFor({ timeout: UI_TIMEOUT });
      await search.fill('second');
      await page.getByRole('heading', { name: 'Memos' }).last().waitFor({ timeout: UI_TIMEOUT });
      await search.press('ArrowDown');
      await search.press('Enter');
      const box = page.getByRole('textbox', { name: 'Memo text' });
      await box.waitFor({ timeout: UI_TIMEOUT });
      const id = page.url().split('#memo/')[1] ?? '';
      await page
        .getByRole('button', { name: 'Delete', exact: true })
        .click({ timeout: UI_TIMEOUT });
      await until(
        () => storedMemo(ext, id),
        (value) => value === undefined,
      );
      if ((await storedMemo(ext, id)) !== undefined) {
        throw new Error('not deleted');
      }
      await page.getByRole('button', { name: 'Undo', exact: true }).click({ timeout: UI_TIMEOUT });
      const back = await until(
        () => storedMemo(ext, id),
        (value) => value !== undefined,
      );
      if (back?.text !== 'First line\nsecond') {
        throw new Error(`after Undo: ${JSON.stringify(back)}`);
      }
      await page.close();
      return 'found, opened, deleted and brought back';
    });

    for (const how of ['close', 'reload', 'navigate'] as const) {
      for (const [label, size] of [
        ['10 characters', 10],
        ['300 KB', 300 * 1024],
      ] as const) {
        await check(`${how} at ${label} keeps the text, ${RUNS} runs`, async () => {
          for (let run = 0; run < RUNS; run += 1) {
            const id = `e2e-${how}-${size}-${run}`;
            await seedMemo(home, id, 'before');
            const page = await openMemo(ext, id);
            const text = `${run}:`.padEnd(size, 'x');
            // fill() sets the value and fires input: the autosave timer starts, and the page goes
            // before it runs.
            await page.getByRole('textbox', { name: 'Memo text' }).fill(text);
            await leave(page, how);
            const memo = await until(
              () => storedMemo(ext, id),
              (value) => value?.text === text,
            );
            if (memo?.text !== text) {
              throw new Error(`run ${run}: stored ${memo?.text.slice(0, 20) ?? 'nothing'}`);
            }
            if (!page.isClosed()) {
              await page.close();
            }
          }
          return `${RUNS} of ${RUNS} saved`;
        });
      }
    }

    await check('a language change synced while typing saves the text first', async () => {
      const id = 'e2e-language';
      await seedMemo(home, id, 'before');
      const page = await openMemo(ext, id);
      await page.getByRole('textbox', { name: 'Memo text' }).fill('typed before the reload');
      const worker = await ext.worker();
      await worker.evaluate(async () => {
        await chrome.storage.sync.set({ uiLanguage: 'es' });
      });
      await page.waitForEvent('load', { timeout: UI_TIMEOUT });
      const memo = await until(
        () => storedMemo(ext, id),
        (value) => value?.text === 'typed before the reload',
      );
      await worker.evaluate(async () => {
        await chrome.storage.sync.set({ uiLanguage: 'auto' });
      });
      if (memo?.text !== 'typed before the reload') {
        throw new Error(`stored ${JSON.stringify(memo?.text)}`);
      }
      return 'saved, then reloaded';
    });
  } finally {
    await ext.close();
  }

  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}`);
  }
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

await main();
