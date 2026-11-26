import { POLICY } from '@/constants';
import { folderUrl, myDriveUrl } from '@/lib/docs-url';
import { joinFacts, t } from '@/lib/i18n';
import type { DocRef, PathAnswer, PathSegment } from '@/types';

/**
 * What the title bar shows for an answer, decided here so the DOM code only draws it. Every text
 * is a whole message through `t()`; the separator is a typographic mark, not a word.
 */

export const SEPARATOR = '›';
export const ELLIPSIS = '…';
const SEPARATOR_TEXT = ` ${SEPARATOR} `;

export interface PathItem {
  label: string;
  /** Drive's address for this folder; absent for the "..." stand-in. */
  href?: string;
  title: string;
}

export type PathView =
  | { kind: 'path'; items: PathItem[]; title: string }
  | { kind: 'text'; text: string; title: string }
  | { kind: 'button'; text: string; title: string; action: 'sign-in' | 'retry' }
  | { kind: 'loading'; text: string; title: string };

/** A segment's name as shown: My Drive and an unnamed shared drive in the UI's language. */
export function segmentLabel(segment: PathSegment): string {
  if (segment.kind === 'my-drive') {
    return t('pathMyDrive');
  }
  if (segment.name.trim() === '') {
    return segment.kind === 'shared-drive' ? t('pathSharedDrive') : t('pathUntitled');
  }
  return segment.name;
}

/** Cuts one long name at the end, keeping it under `max` characters with an ellipsis. */
export function shortenLabel(label: string, max: number): string {
  const chars = Array.from(label);
  return chars.length <= max
    ? label
    : `${chars.slice(0, Math.max(1, max - 1)).join('')}${ELLIPSIS}`;
}

/**
 * Where to cut a path of names with these lengths so it fits `maxChars`: keep the first `head` and
 * the last `tail` names with one ellipsis between them. `undefined` when it fits as it is (or has
 * nothing in its middle to drop). The last name is always kept, even when it alone is too long.
 */
export function middleCut(
  lengths: number[],
  maxChars: number,
): { head: number; tail: number } | undefined {
  const n = lengths.length;
  const total = lengths.reduce((sum, length) => sum + length, 0) + SEPARATOR_TEXT.length * (n - 1);
  if (total <= maxChars || n <= 2) {
    return undefined;
  }
  const first = lengths[0] ?? 0;
  const last = lengths[n - 1] ?? 0;
  let used = first + last + SEPARATOR_TEXT.length * 2 + ELLIPSIS.length;
  let tail = 1;
  while (tail < n - 2) {
    const next = lengths[n - 1 - tail] ?? 0;
    if (used + next + SEPARATOR_TEXT.length > maxChars) {
      break;
    }
    used += next + SEPARATOR_TEXT.length;
    tail += 1;
  }
  return { head: 1, tail };
}

/** The whole path as one line of text, for the tooltip. */
export function fullPathText(labels: string[], partial: boolean): string {
  return [...(partial ? [ELLIPSIS] : []), ...labels].join(SEPARATOR_TEXT);
}

function errorText(reason: 'network' | 'unknown'): string {
  return reason === 'network' ? t('errorNetwork') : t('errorUnknown');
}

/** The title bar's view of `answer` for the file `doc`. */
export function pathView(answer: PathAnswer, doc: DocRef): PathView {
  switch (answer.state) {
    case 'not-configured':
      return { kind: 'text', text: t('pathNotConfigured'), title: t('pathNotConfiguredTitle') };
    case 'needs-sign-in':
      return {
        kind: 'button',
        text: t('pathShowButton'),
        title: t('pathShowTitle'),
        action: 'sign-in',
      };
    case 'error':
      if (answer.reason === 'wrong-account') {
        return {
          kind: 'button',
          text: t('pathWrongAccount'),
          title: t('pathWrongAccountTitle'),
          action: 'sign-in',
        };
      }
      if (answer.reason === 'cancelled') {
        return {
          kind: 'button',
          text: t('pathShowButton'),
          title: t('pathShowTitle'),
          action: 'sign-in',
        };
      }
      return {
        kind: 'button',
        text: t('pathError'),
        title: t('pathErrorTitle', errorText(answer.reason)),
        action: 'retry',
      };
    case 'ready':
      break;
  }

  const path = answer.path;
  if (path.kind === 'hidden') {
    const text = joinFacts([
      t('pathHidden'),
      ...(path.owner === undefined ? [] : [t('pathOwner', path.owner)]),
    ]);
    return { kind: 'text', text, title: `${text}. ${t('pathHiddenTitle')}` };
  }

  const labels = path.segments.map(segmentLabel);
  const full = fullPathText(labels, path.partial);
  const title = path.partial
    ? `${t('pathFullTitle', full)} ${t('pathPartialTitle')}`
    : t('pathFullTitle', full);

  const shown = labels.map((label) => shortenLabel(label, POLICY.path.maxSegmentChars));
  const items: PathItem[] = path.segments.map((segment, index) => {
    const label = labels[index] ?? '';
    return {
      label: shown[index] ?? label,
      href:
        segment.kind === 'my-drive'
          ? myDriveUrl(doc.accountIndex)
          : folderUrl(segment.id, doc.accountIndex),
      title: t('pathOpenInDrive', label),
    };
  });

  const cut = middleCut(
    shown.map((label) => Array.from(label).length),
    POLICY.path.maxChars - (path.partial ? ELLIPSIS.length + SEPARATOR_TEXT.length : 0),
  );
  const gap: PathItem = { label: ELLIPSIS, title: full };
  const kept =
    cut === undefined
      ? items
      : [...items.slice(0, cut.head), gap, ...items.slice(items.length - cut.tail)];
  const lead: PathItem[] = path.partial ? [{ label: ELLIPSIS, title: t('pathPartialTitle') }] : [];
  return { kind: 'path', items: [...lead, ...kept], title };
}

/** Shown while the worker is asked. */
export function loadingView(): PathView {
  return { kind: 'loading', text: t('pathLoading'), title: t('pathLoading') };
}
