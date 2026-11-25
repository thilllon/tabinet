/**
 * The KEK, kept outside the repository and outside any build:
 *
 *   pnpm --filter tabinet-server kek:new <absolute path>   writes a new KEK, prints only its id
 *   pnpm --filter tabinet-server kek:id <absolute path>    prints the id of the KEK in a file
 *
 * The file holds base64 of 32 random bytes, no newline, mode 0600, and is never overwritten. Both
 * refuse a relative path and any path inside the repository, so a KEK cannot be committed by
 * accident. The key itself is never printed.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { KEK_BYTES, kekIdOfSync } from '../src/envelope.js';
import { decodeBase64 } from '../src/validation.js';

/** The repository this script belongs to. */
export const REPOSITORY = path.resolve(import.meta.dirname, '../..');

/** The file's absolute path with every link resolved, or a throw for one inside `repository`. */
export function outsideRepository(file: string, repository = REPOSITORY): string {
  if (!path.isAbsolute(file)) {
    throw new Error('Give an absolute path');
  }
  // The folder exists; the file may not yet. Links are resolved on both sides.
  const resolved = path.join(realpathSync(path.dirname(file)), path.basename(file));
  const root = realpathSync(repository);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Refusing a path inside the repository');
  }
  return resolved;
}

/** Writes a new KEK to `file` (which must not exist) and returns its id. */
export function newKek(file: string, repository = REPOSITORY): string {
  const target = outsideRepository(file, repository);
  const kek = randomBytes(KEK_BYTES);
  try {
    writeFileSync(target, kek.toString('base64'), { flag: 'wx', mode: 0o600 });
    return kekIdOfSync(kek);
  } finally {
    kek.fill(0);
  }
}

/** The id of the KEK in `file`. */
export function kekIdOfFile(file: string, repository = REPOSITORY): string {
  const kek = decodeBase64(readFileSync(outsideRepository(file, repository), 'utf8'));
  if (kek === null || kek.length !== KEK_BYTES) {
    throw new Error('The file does not hold base64 of 32 bytes');
  }
  try {
    return kekIdOfSync(kek);
  } finally {
    kek.fill(0);
  }
}

function main(argv: string[]): void {
  const [command, file] = argv;
  if ((command !== 'new' && command !== 'id') || file === undefined || argv.length !== 2) {
    console.error('Usage: kek:new <absolute path> | kek:id <absolute path>');
    process.exit(2);
  }
  try {
    console.log(command === 'new' ? newKek(file) : kekIdOfFile(file));
  } catch (err) {
    // The message only: it never holds the key.
    console.error(err instanceof Error ? err.message : 'Failed');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
