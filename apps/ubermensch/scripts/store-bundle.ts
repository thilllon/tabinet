/**
 * Gathers what the Chrome Web Store dashboard asks for into release/store-<version>/: the upload
 * zip, the screenshots per language and SUBMIT.md with every text from store-listing.ts.
 *
 *   pnpm --filter ubermensch build && pnpm --filter ubermensch zip && pnpm --filter ubermensch store:bundle
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CWS_SUMMARY_MAX_CHARS,
  DATA_CERTIFICATIONS,
  DATA_TYPES,
  DATA_USAGE,
  DEFAULT_LISTING_LOCALE,
  DISTRIBUTION,
  HOST_PERMISSIONS_AND_REMOTE_CODE,
  LISTING_LOCALES,
  LOCALE_NAMES,
  OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS,
  PERMISSION_JUSTIFICATIONS,
  PRODUCT_DETAILS,
  readLocaleMessage,
  SINGLE_PURPOSE,
  STORE_DESCRIPTIONS,
  TEST_INSTRUCTIONS,
} from './store-listing';
import { readPackage, zipFileName } from './zip-name';

const ROOT = path.resolve(import.meta.dirname, '..');

function fence(text: string): string {
  return ['```text', text, '```'].join('\n');
}

function main(): void {
  const { displayName, version } = readPackage(path.join(ROOT, 'package.json'));
  const zip = zipFileName(displayName, version);
  const zipPath = path.join(ROOT, 'release', zip);
  if (!existsSync(zipPath)) {
    throw new Error(`release/${zip} is missing: run the build and the zip script first`);
  }
  const out = path.join(ROOT, 'release', `store-${version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(zipPath, path.join(out, zip));

  const shots: string[] = [];
  for (const code of LISTING_LOCALES) {
    const from = path.join(ROOT, 'assets', code);
    if (!existsSync(from)) {
      continue;
    }
    const to = path.join(out, 'screenshots', code);
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)
      .filter((name) => name.endsWith('.png'))
      .sort()) {
      copyFileSync(path.join(from, file), path.join(to, file));
      shots.push(`screenshots/${code}/${file}`);
    }
  }

  const promo = path.join(ROOT, 'assets', 'promo-small.png');
  if (existsSync(promo)) {
    copyFileSync(promo, path.join(out, 'promo-small.png'));
    shots.push('promo-small.png (small promo tile, 440x280)');
  }

  const lines: string[] = [
    `# ${displayName} ${version}: Chrome Web Store submission`,
    '',
    `Upload: \`${zip}\` (Package tab). Screenshots: \`screenshots/<language>/\`, 1280x800, in file order.`,
    '',
    '## Store listing',
    '',
    `Title and Summary come from the package (extName, extDescription; Summary at most ${CWS_SUMMARY_MAX_CHARS} characters).`,
    '',
  ];
  for (const code of LISTING_LOCALES) {
    lines.push(
      `### ${LOCALE_NAMES[code]} (${code})${code === DEFAULT_LISTING_LOCALE ? ', the default' : ''}`,
      '',
      `Summary: ${readLocaleMessage(code, 'extDescription')}`,
      '',
      'Description:',
      '',
      fence(STORE_DESCRIPTIONS[code]),
      '',
    );
  }
  lines.push(
    '## Product details',
    '',
    `- Category: ${PRODUCT_DETAILS.category}`,
    `- Homepage: ${PRODUCT_DETAILS.homepageUrl}`,
    `- Support: ${PRODUCT_DETAILS.supportUrl}`,
    `- Mature content: ${PRODUCT_DETAILS.matureContent}`,
    '',
    '## Privacy practices',
    '',
    'Single purpose:',
    '',
    fence(SINGLE_PURPOSE),
    '',
    'Permission justifications:',
    '',
  );
  for (const [permission, text] of Object.entries(PERMISSION_JUSTIFICATIONS)) {
    lines.push(`- \`${permission}\``, '', fence(text), '');
  }
  for (const [origin, text] of Object.entries(OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS)) {
    lines.push(`- \`${origin}\` (optional host permission)`, '', fence(text), '');
  }
  lines.push(
    'Host permissions and remote code:',
    '',
    fence(HOST_PERMISSIONS_AND_REMOTE_CODE),
    '',
    'Data usage:',
    '',
    fence(DATA_USAGE),
    '',
    `Data types ticked: ${DATA_TYPES.ticked.join(', ')}. Not collected: ${DATA_TYPES.notCollected}.`,
    '',
    fence(DATA_TYPES.justification),
    '',
    'Certifications (tick all three):',
    '',
    ...DATA_CERTIFICATIONS.map((text) => `- ${text}`),
    '',
    `Privacy policy URL: ${PRODUCT_DETAILS.privacyPolicyUrl}`,
    '',
    '## Test instructions',
    '',
    fence(TEST_INSTRUCTIONS),
    '',
    '## Distribution',
    '',
    `- Visibility: ${DISTRIBUTION.visibility}`,
    `- Regions: ${DISTRIBUTION.regions}`,
    `- Pricing: ${DISTRIBUTION.pricing}`,
    '',
    '## Files',
    '',
    `- ${zip}`,
    ...shots.map((shot) => `- ${shot}`),
    '',
  );
  writeFileSync(path.join(out, 'SUBMIT.md'), lines.join('\n'));
  console.log(`Wrote release/store-${version}/ (${shots.length} screenshots)`);
}

main();
