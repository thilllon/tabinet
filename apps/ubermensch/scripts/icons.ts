/**
 * Renders public/img/logo.svg into the PNG icons the manifest names (16, 32, 48, 128), headless.
 * Run after changing the mark: `pnpm --filter ubermensch icons`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { launchHeadless } from './browser';

const SIZES = [16, 32, 48, 128] as const;
const IMG = path.resolve(import.meta.dirname, '../public/img');

async function main(): Promise<void> {
  const svg = readFileSync(path.join(IMG, 'logo.svg'), 'utf8');
  const browser = await launchHeadless();
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`,
      );
      await page.screenshot({ path: path.join(IMG, `logo-${size}.png`), omitBackground: true });
      await page.close();
      console.log(`img/logo-${size}.png`);
    }
  } finally {
    await browser.close();
  }
}

void main();
