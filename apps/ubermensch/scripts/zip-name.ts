import { readFileSync } from 'node:fs';

/**
 * The upload zip's file name, `Ubermensch-<version>.zip`: the display name with its accents taken
 * off (the store and every unzip tool handle a plain ASCII name), never the manifest's
 * `__MSG_extName__`.
 */
export function zipFileName(displayName: string, version: string): string {
  if (displayName.includes('__MSG_')) {
    throw new Error(`Not a display name: ${displayName}`);
  }
  const ascii = displayName
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .trim()
    .replaceAll(/\s+/g, '-');
  return `${ascii}-${version}.zip`;
}

/** `displayName` and `version` from the `package.json` at `packageJsonPath`. */
export function readPackage(packageJsonPath: string): { displayName: string; version: string } {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const displayName =
    typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'displayName') : undefined;
  const version = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'version') : undefined;
  if (typeof displayName !== 'string' || displayName.trim() === '' || typeof version !== 'string') {
    throw new Error(`${packageJsonPath} has no displayName or version`);
  }
  return { displayName, version };
}
