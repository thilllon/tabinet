/**
 * Packages dist/ into release/Ubermensch-<version>.zip for the Chrome Web Store. Run after
 * `pnpm --filter ubermensch build`.
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// archiver 8 is ESM and exports the archive classes by name; there is no callable default.
import { ZipArchive } from 'archiver';

import { readPackage, zipFileName } from './zip-name';

const ROOT = path.resolve(import.meta.dirname, '..');

async function main(): Promise<void> {
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error('dist/manifest.json is missing: run the build first');
  }
  const { displayName, version } = readPackage(path.join(ROOT, 'package.json'));
  const filename = zipFileName(displayName, version);
  const releaseDir = path.join(ROOT, 'release');
  mkdirSync(releaseDir, { recursive: true });

  const output = createWriteStream(path.join(releaseDir, filename));
  const archive = new ZipArchive({ zlib: { level: 9 } });
  // `finalize()` resolves before the file is complete; the write stream's `close` is the end.
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });
  archive.on('error', (err: Error) => {
    throw err;
  });
  archive.pipe(output);
  archive.directory(`${dist}/`, false);
  await archive.finalize();
  await closed;
  console.log(`Packaged: release/${filename} (${archive.pointer()} bytes)`);
}

void main();
