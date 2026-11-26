import type { DocKind, DocRef } from '@/types';

const DOCS_HOST = 'docs.google.com';

/**
 * `/document/d/<id>/...`, `/spreadsheets/u/1/d/<id>/...` and the like. A Drive file id is at least
 * 25 characters of `[A-Za-z0-9_-]`; the floor of 10 only rules out `/d/e/<published id>`, the
 * "publish to the web" address, which is not an editor and whose id is not a file id.
 */
const PATH_PATTERN =
  /^\/(document|spreadsheets|presentation)\/(?:u\/(\d{1,3})\/)?d\/([\w-]{10,})(?:\/|$)/;

/** The file a Docs, Sheets or Slides address opens, or `undefined` for any other address. */
export function parseDocUrl(url: string): DocRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== DOCS_HOST) {
    return undefined;
  }
  const match = PATH_PATTERN.exec(parsed.pathname);
  if (!match) {
    return undefined;
  }
  const [, kind, index, fileId] = match;
  if (!isDocKind(kind) || fileId === undefined) {
    return undefined;
  }
  // `?authuser=1` is the other way an address names its account; the path wins when both do.
  const fromQuery = parsed.searchParams.get('authuser');
  const accountIndex = parseIndex(index) ?? parseIndex(fromQuery ?? undefined);
  return accountIndex === undefined ? { kind, fileId } : { kind, fileId, accountIndex };
}

function isDocKind(value: string | undefined): value is DocKind {
  return value === 'document' || value === 'spreadsheets' || value === 'presentation';
}

function parseIndex(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,3}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** Drive's address for a folder (a shared drive's root too), in the page's account. */
export function folderUrl(folderId: string, accountIndex?: number): string {
  return `${driveBase(accountIndex)}/folders/${encodeURIComponent(folderId)}`;
}

/** Drive's address for My Drive, in the page's account. */
export function myDriveUrl(accountIndex?: number): string {
  return `${driveBase(accountIndex)}/my-drive`;
}

function driveBase(accountIndex?: number): string {
  return accountIndex === undefined
    ? 'https://drive.google.com/drive'
    : `https://drive.google.com/drive/u/${accountIndex}`;
}
