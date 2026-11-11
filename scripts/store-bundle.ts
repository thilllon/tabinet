/**
 * Collects everything needed to submit a release to the Chrome Web Store into one folder.
 *
 * Nothing here *produces* an asset. `prepare-registration.ts` shoots the screenshots and promo
 * images and `zip.ts` packages `dist/`; this step gathers those, puts the screenshots in upload
 * order (one folder per language), and writes a SUBMIT.md holding everything the dashboard asks
 * for: the listing and privacy text from `scripts/store-listing.ts`, and Title and Summary read
 * from the built manifest and its `_locales` rather than retyped.
 *
 * It runs as the last `after:bump` hook of `pnpm release`, and standalone as `pnpm store:bundle`
 * for when only the wording changed.
 *
 *     pnpm store:bundle
 *
 * Output: `release/store-<version>/` (git-ignored, like everything else under `release/`).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_CERTIFICATIONS,
  DATA_TYPES,
  DATA_USAGE,
  DEFAULT_LISTING_LOCALE,
  DISTRIBUTION,
  HOST_PERMISSIONS_AND_REMOTE_CODE,
  OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS,
  LISTING_LOCALES,
  type ListingLocale,
  LOCALE_NAMES,
  PERMISSION_JUSTIFICATIONS,
  PRODUCT_DETAILS,
  readLocaleMessage,
  SINGLE_PURPOSE,
  STORE_DESCRIPTIONS,
  TEST_INSTRUCTIONS,
  validateDescription,
  validateSummary,
} from './store-listing';
import { readDisplayName, zipFileName } from './zip-name';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * The screenshots, in upload order. The first is the one that shows up in store search results, so
 * it leads with the product doing its job.
 *
 * `screenshot-1280x800.png` is captured from `app.html#settings` with nothing seeded, so it is the
 * Settings dialog over an empty page: useful as context, useless as a first impression. It goes
 * last.
 *
 * The store takes at most five, so `dashboard-restore.png` (the large-restore confirm dialog) is
 * shot for the website but not uploaded: the sessions screenshot already shows what a restore
 * brings back.
 */
const SCREENSHOTS: { from: string; as: string; caption: string }[] = [
  {
    from: 'dashboard-sessions.png',
    as: '01-sessions-1280x800.png',
    caption: 'Save whole windows as a session - tab groups, pinned tabs and order all come back',
  },
  {
    from: 'dashboard-notes.png',
    as: '02-youtube-notes-1280x800.png',
    caption: 'Timestamped notes and screenshots on YouTube videos, a click away from that moment',
  },
  {
    from: 'dashboard-search.png',
    as: '03-search-1280x800.png',
    caption: 'Search every open tab, saved session and note at once',
  },
  {
    from: 'dashboard-history.png',
    as: '04-auto-snapshots-1280x800.png',
    caption: 'Automatic snapshots quietly keep a safety net for crashes',
  },
  {
    from: 'screenshot-1280x800.png',
    as: '05-settings-1280x800.png',
    caption: 'Three settings that matter up front, the rest folded away',
  },
];

const PROMOS: { from: string; as: string; slot: string; size: string }[] = [
  {
    from: 'assets/promo-small-440x280.png',
    as: 'small-tile-440x280.png',
    slot: 'Small promo tile',
    size: '440×280',
  },
  {
    from: 'assets/promo-marquee-1400x560.png',
    as: 'marquee-1400x560.png',
    slot: 'Marquee',
    size: '1400×560',
  },
  { from: 'public/img/logo-128.png', as: 'icon-128.png', slot: 'Icon', size: '128×128' },
];

interface Manifest {
  name: string;
  version: string;
  description: string;
  default_locale?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  minimum_chrome_version?: string;
}

/** One language's part of SUBMIT.md, every text read from the build or the listing data. */
interface LocaleSection {
  locale: ListingLocale;
  title: string;
  summary: string;
  description: string;
  /** Where its screenshots sit inside the bundle, or `null` when it uses the English ones. */
  screenshotDir: string | null;
}

const LOCALES_DIR = path.join(ROOT, 'dist', '_locales');

/**
 * The manifest names a message (`__MSG_extName__`) rather than holding the text; resolve it the
 * way Chrome does, through `dist/_locales/<locale>/messages.json`, falling back to the default
 * locale. Text without a placeholder comes back as it is.
 */
function resolveMessages(value: string, locale: string, fallback: string): string {
  return value.replace(/__MSG_(\w+)__/g, (whole, key: string) => {
    const text =
      readLocaleMessage(LOCALES_DIR, locale, key) ?? readLocaleMessage(LOCALES_DIR, fallback, key);
    if (text === undefined) {
      throw new Error(`dist/_locales has no message "${key}" for ${whole} (locale ${locale})`);
    }
    return text;
  });
}

/** The localized screenshots of one language, if `assets/<lang>/` holds any of them. */
function hasLocalizedScreenshots(locale: ListingLocale): boolean {
  return SCREENSHOTS.some((shot) => existsSync(path.join(ROOT, 'assets', locale, shot.from)));
}

function copyInto(from: string, to: string, missing: string[]): void {
  if (!existsSync(from)) {
    missing.push(path.relative(ROOT, from));
    return;
  }
  copyFileSync(from, to);
}

function localeSectionDoc(section: LocaleSection, isDefault: boolean): string {
  const name = LOCALE_NAMES[section.locale];
  const shots =
    section.screenshotDir === null
      ? `Screenshots: none of its own; the store shows the ${LOCALE_NAMES[DEFAULT_LISTING_LOCALE]} ones. Leave the field empty.`
      : `Screenshots: \`${section.screenshotDir}/\`, in the order of section 3.`;
  return `### ${name} (\`${section.locale}\`)${isDefault ? ' - default language' : ''}

Set the Store listing tab's language menu to **${name}**${isDefault ? ' (the default: every language without its own listing shows this one)' : ''}.

**Title** (read from the package, not editable in the dashboard)

\`\`\`
${section.title}
\`\`\`

**Summary** (${section.summary.length} / 132 characters; \`extDescription\` in \`_locales/${section.locale}/messages.json\`, read from the package, not editable in the dashboard)

\`\`\`
${section.summary}
\`\`\`

**Description** (${section.description.length.toLocaleString('en-US')} / 500 characters)

\`\`\`text
${section.description}
\`\`\`

${shots}
`;
}

function submitDoc(
  manifest: Manifest,
  sections: LocaleSection[],
  zipName: string,
  missing: string[],
): string {
  const permissions = manifest.permissions ?? [];
  const unknown = permissions.filter((name) => PERMISSION_JUSTIFICATIONS[name] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `No store justification for permission(s): ${unknown.join(', ')}. ` +
        'Add one to PERMISSION_JUSTIFICATIONS in scripts/store-listing.ts - the store rejects a blank field.',
    );
  }
  if ((manifest.host_permissions ?? []).length > 0) {
    throw new Error(
      `The manifest requests host permissions (${manifest.host_permissions?.join(', ')}); ` +
        'HOST_PERMISSIONS_AND_REMOTE_CODE in scripts/store-listing.ts says none.',
    );
  }
  const optionalHosts = manifest.optional_host_permissions ?? [];
  const unjustifiedHosts = optionalHosts.filter(
    (origin) => OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS[origin] === undefined,
  );
  if (unjustifiedHosts.length > 0) {
    throw new Error(
      `No store justification for optional host permission(s): ${unjustifiedHosts.join(', ')}. ` +
        'Add one to OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS in scripts/store-listing.ts.',
    );
  }

  const shots = SCREENSHOTS.map((s, i) => `| ${i + 1} | \`${s.as}\` | ${s.caption} |`).join('\n');
  const shotFolders = sections
    .map(
      (section) =>
        `- ${LOCALE_NAMES[section.locale]}: ${section.screenshotDir === null ? 'none (the store shows the English ones)' : `\`${section.screenshotDir}/\``}`,
    )
    .join('\n');
  const listings = sections
    .map((section) => localeSectionDoc(section, section.locale === DEFAULT_LISTING_LOCALE))
    .join('\n');
  const languages = sections
    .map((section) => `${LOCALE_NAMES[section.locale]} (\`${section.locale}\`)`)
    .join(', ');
  const promos = PROMOS.map((p) => `| ${p.slot} | \`promo/${p.as}\` | ${p.size} |`).join('\n');
  const perms = permissions
    .map((name) => `**${name}**\n\n\`\`\`\n${PERMISSION_JUSTIFICATIONS[name]}\n\`\`\``)
    .join('\n\n');
  const hostPerms = optionalHosts
    .map(
      (origin) =>
        `**\`${origin}\`** (optional)\n\n\`\`\`\n${OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS[origin]}\n\`\`\``,
    )
    .join('\n\n');
  const certifications = DATA_CERTIFICATIONS.map((line) => `- [x] ${line}`).join('\n');
  const warning =
    missing.length === 0
      ? ''
      : `\n> **Incomplete.** These assets were not found when this folder was built, so they are ` +
        `missing here:\n>\n${missing.map((m) => `> - \`${m}\``).join('\n')}\n>\n` +
        `> Re-run \`pnpm release\` (or \`tsx scripts/prepare-registration.ts\`) and then ` +
        `\`pnpm store:bundle\`.\n`;

  return `# Chrome Web Store - ${manifest.name} ${manifest.version}

Everything in this folder is ready to paste or upload.
${warning}
Dashboard: https://chrome.google.com/webstore/devconsole

Generated by \`scripts/store-bundle.ts\` from \`scripts/store-listing.ts\` (edit the text there,
never in this file) and the built package. Re-run \`pnpm store:bundle\` after a change.

---

## 1. Package

Upload \`${zipName}\` under **Package → Upload new package**.

Manifest V3, no remotely hosted code. The listing below covers ${languages}; each is a folder of
the package's \`_locales\`, which is what the dashboard's language menu offers.

---

## 2. Store listing

| Field | Value |
|---|---|
| Category | ${PRODUCT_DETAILS.category} |
| Homepage URL | ${PRODUCT_DETAILS.homepageUrl} |
| Support URL | ${PRODUCT_DETAILS.supportUrl} |
| Mature content | ${PRODUCT_DETAILS.matureContent} |
| Promo video | ${PRODUCT_DETAILS.promoVideo} |

Fill one block per language. Title and Summary come out of the package for each language, so
only the Description and the images are entered by hand.

${listings}
---

## 3. Screenshots

Upload in this order, for each language from its own folder. The first is what people see in
search results.

| # | File | Suggested caption |
|---|------|-------------------|
${shots}

Folders:

${shotFolders}

All are 1280×800. The store accepts 1280×800 or 640×400; one size is enough.

---

## 4. Promo images (optional, but they unlock placement)

The promo tiles carry English text and are shared by every language.

| Slot | File | Size |
|------|------|------|
${promos}

---

## 5. Privacy tab - the part that gets submissions rejected

**Single purpose**

\`\`\`
${SINGLE_PURPOSE}
\`\`\`

**Permission justifications** - one per permission the manifest requests:

${perms}

**Host permission justification** - one per optional host permission:

${hostPerms === '' ? 'None.' : hostPerms}

${HOST_PERMISSIONS_AND_REMOTE_CODE} Minimum Chrome version: ${manifest.minimum_chrome_version ?? 'none'} (\`minimum_chrome_version\` in the manifest).

**Data usage**

\`\`\`
${DATA_USAGE}
\`\`\`

Data types: tick ${DATA_TYPES.ticked.map((name) => `**${name}**`).join(', ')} only, with this justification:

\`\`\`
${DATA_TYPES.justification}
\`\`\`

Not collected: ${DATA_TYPES.notCollected}.

Certifications - all three apply:

${certifications}

Privacy policy URL:

\`\`\`
${PRODUCT_DETAILS.privacyPolicyUrl}
\`\`\`

---

## 6. Test instructions tab

Username and password: leave both empty (no test account is needed; the optional sync signs in with the reviewer's own Google account).

\`\`\`
${TEST_INSTRUCTIONS}
\`\`\`

---

## 7. Distribution tab

| Field | Value |
|---|---|
| Visibility | ${DISTRIBUTION.visibility} |
| Regions | ${DISTRIBUTION.regions} |
| Pricing | ${DISTRIBUTION.pricing} |

---

## 8. Before clicking Submit

- [ ] Version in the uploaded zip reads **${manifest.version}**.
- [ ] Every language in the menu shows the Title and Summary above.
- [ ] Each language's Description pasted whole; the field does not complain about length.
- [ ] Screenshots uploaded in the order above, per language.
- [ ] Every permission has its justification filled in - a blank one is the single most common
      cause of a rejection.
- [ ] Data types: only ${DATA_TYPES.ticked.join(', ')} ticked; all three certifications ticked.
`;
}

function main(): void {
  const manifestPath = path.join(ROOT, 'dist', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No dist/manifest.json - run \`pnpm build\` first.`);
  }
  const raw: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const defaultLocale = raw.default_locale ?? DEFAULT_LISTING_LOCALE;
  const manifest: Manifest = {
    ...raw,
    name: resolveMessages(raw.name, defaultLocale, defaultLocale),
    description: resolveMessages(raw.description, defaultLocale, defaultLocale),
  };

  /*
   * Refuse a dev build. `pnpm dev` writes its own `dist/` whose manifest is named "… Dev" and
   * whose code is loaded from localhost, so a bundle built from it would carry the wrong product
   * name into every field of SUBMIT.md and a zip that does not run without a dev server. Inside
   * `pnpm release` this cannot happen - the hook runs straight after `pnpm build` - but standalone
   * it is one stray `pnpm dev` away.
   */
  if (manifest.name.endsWith(' Dev')) {
    throw new Error(
      `dist/ holds a development build ("${manifest.name}"). Stop \`pnpm dev\`, run \`pnpm build\`, then try again.`,
    );
  }

  const out = path.join(ROOT, 'release', `store-${manifest.version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'screenshots'), { recursive: true });
  mkdirSync(path.join(out, 'promo'), { recursive: true });

  const missing: string[] = [];

  // The same name zip.ts gives the file: package.json's displayName, never the manifest's
  // `__MSG_extName__`.
  const zipName = zipFileName(readDisplayName(path.join(ROOT, 'package.json')), manifest.version);
  copyInto(path.join(ROOT, 'release', zipName), path.join(out, zipName), missing);

  // Both limits count characters (`.length`), not bytes: measured with `wc -c` the Korean and
  // Japanese texts read about three times their real length.
  //
  // Every language, English included, gets its own screenshots/<code>/ folder, so the bundle
  // reads the same for each; a language without its own images shows the English ones.
  const sections: LocaleSection[] = LISTING_LOCALES.map((locale) => {
    const description = STORE_DESCRIPTIONS[locale];
    validateDescription(description);
    const summary = resolveMessages(raw.description, locale, defaultLocale);
    validateSummary(summary);
    const own = locale === DEFAULT_LISTING_LOCALE || hasLocalizedScreenshots(locale);
    return {
      locale,
      title: resolveMessages(raw.name, locale, defaultLocale),
      summary,
      description,
      screenshotDir: own ? `screenshots/${locale}` : null,
    };
  });

  for (const section of sections) {
    if (section.screenshotDir === null) {
      continue;
    }
    const from =
      section.locale === DEFAULT_LISTING_LOCALE
        ? path.join(ROOT, 'assets')
        : path.join(ROOT, 'assets', section.locale);
    mkdirSync(path.join(out, section.screenshotDir), { recursive: true });
    for (const shot of SCREENSHOTS) {
      copyInto(path.join(from, shot.from), path.join(out, section.screenshotDir, shot.as), missing);
    }
  }
  for (const promo of PROMOS) {
    copyInto(path.join(ROOT, promo.from), path.join(out, 'promo', promo.as), missing);
  }

  writeFileSync(path.join(out, 'SUBMIT.md'), submitDoc(manifest, sections, zipName, missing));

  const where = path.relative(ROOT, out);
  console.log(`Store bundle: ${where}/  (start at ${where}/SUBMIT.md)`);
  if (missing.length > 0) {
    console.warn(`  Missing ${missing.length} asset(s); SUBMIT.md lists them:`);
    for (const m of missing) {
      console.warn(`    - ${m}`);
    }
  }
}

main();
