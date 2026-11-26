/**
 * The key encryption key, kept outside the repository and outside any build:
 *
 *   pnpm --filter tabinet-server key-encryption-key:new <absolute path>   writes a new key encryption key, prints only its id
 *   pnpm --filter tabinet-server key-encryption-key:id <absolute path>    prints the id of the key encryption key in a file
 *
 * The file holds base64 of 32 random bytes, no newline, mode 0600, and is never overwritten. Both
 * refuse a relative path and any path inside the repository, so a key encryption key cannot be committed by
 * accident. The key itself is never printed.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { KEY_ENCRYPTION_KEY_BYTES, keyEncryptionKeyIdOfSync } from '../src/envelope.js';
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

/** Writes a new key encryption key to `file` (which must not exist) and returns its id. */
export function newKeyEncryptionKey(file: string, repository = REPOSITORY): string {
  const target = outsideRepository(file, repository);
  const keyEncryptionKey = randomBytes(KEY_ENCRYPTION_KEY_BYTES);
  try {
    writeFileSync(target, keyEncryptionKey.toString('base64'), { flag: 'wx', mode: 0o600 });
    return keyEncryptionKeyIdOfSync(keyEncryptionKey);
  } finally {
    keyEncryptionKey.fill(0);
  }
}

/** The id of the key encryption key in `file`. */
export function keyEncryptionKeyIdOfFile(file: string, repository = REPOSITORY): string {
  const keyEncryptionKey = decodeBase64(readFileSync(outsideRepository(file, repository), 'utf8'));
  if (keyEncryptionKey === null || keyEncryptionKey.length !== KEY_ENCRYPTION_KEY_BYTES) {
    throw new Error('The file does not hold base64 of 32 bytes');
  }
  try {
    return keyEncryptionKeyIdOfSync(keyEncryptionKey);
  } finally {
    keyEncryptionKey.fill(0);
  }
}

function main(argv: string[]): void {
  const [command, file] = argv;
  if ((command !== 'new' && command !== 'id') || file === undefined || argv.length !== 2) {
    console.error(
      'Usage: key-encryption-key:new <absolute path> | key-encryption-key:id <absolute path>',
    );
    process.exit(2);
  }
  try {
    console.log(command === 'new' ? newKeyEncryptionKey(file) : keyEncryptionKeyIdOfFile(file));
  } catch (err) {
    // The message only: it never holds the key.
    console.error(err instanceof Error ? err.message : 'Failed');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
