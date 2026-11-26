/**
 * Every lookup into Google's Docs, Sheets and Slides pages, in one place. Google changes this DOM
 * without notice, so each lookup has fallbacks and returns `undefined` when none matches: the path
 * is then simply not shown, and the page is never touched beyond the one element we add.
 *
 * Verified 2026-11-26 in headless Chromium on public sample files of all three editors (signed
 * out): the title row is `.docs-title-outer` (a flex row: `#docs-title-widget`, the hidden
 * `#office-editing-file-extension` and `#docs-parent-collections-container-outer`, then
 * `.docs-titlebar-badges`). `.docs-titlebar-badges` is itself a flex row (star, folder, cloud
 * status) right after the title; an element appended to it sits just after the cloud icon. Typing
 * a new title re-renders `.docs-title-input-label-inner` only, never the badges.
 */

/** Where the path goes, most specific first. Each entry: a selector, and append inside it. */
export const MOUNT_ANCHORS = [
  '.docs-titlebar-badges',
  '.docs-title-outer',
  '#docs-titlebar',
] as const;

/** The element the path is appended to, or `undefined` when the page has none of them. */
export function findMountAnchor(root: ParentNode): Element | undefined {
  for (const selector of MOUNT_ANCHORS) {
    const element = root.querySelector(selector);
    if (element !== null) {
      return element;
    }
  }
  return undefined;
}

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** The first e-mail address in a label such as "Google Account: Kim (kim@example.com)". */
export function emailFromLabel(label: string | null | undefined): string | undefined {
  if (label === null || label === undefined) {
    return undefined;
  }
  return EMAIL_PATTERN.exec(label)?.[0];
}

/**
 * Google's account button carries the signed-in address in its `aria-label`. Not confirmed live
 * (the research was done signed out, on purpose); when it is not found the `/u/<n>/` index is the
 * only hint and sign-in passes that instead.
 */
const ACCOUNT_SELECTORS = [
  'a[href^="https://accounts.google.com/SignOutOptions"]',
  'header [aria-label*="@"]',
  '#gb [aria-label*="@"]',
  '[role="banner"] [aria-label*="@"]',
] as const;

export function findAccountEmail(root: ParentNode): string | undefined {
  for (const selector of ACCOUNT_SELECTORS) {
    for (const element of Array.from(root.querySelectorAll(selector))) {
      const email = emailFromLabel(element.getAttribute('aria-label'));
      if (email !== undefined) {
        return email;
      }
    }
  }
  return undefined;
}
