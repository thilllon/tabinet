import { DRIVE_FILE_FIELDS, POLICY } from '@/constants';
import type { DriveFile } from '@/types';

/**
 * The three Drive API v3 calls the extension makes, all metadata only: `files.get` (name, parents,
 * shared drive, owner), `drives.get` (a shared drive's name) and `about.get` (which address a token
 * belongs to). Nothing ever asks for content. Every answer is checked by hand before use.
 */

const API = 'https://www.googleapis.com/drive/v3';

/** Drive answered with an HTTP error. 401 means the token is no good; 403 and 404, not visible. */
export class DriveApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Drive API answered ${status}`);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

/** Drive could not be reached, did not answer in time, or answered something unreadable. */
export class DriveNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveNetworkError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, token: string, fetchImpl: FetchLike): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(POLICY.request.timeoutMs),
    });
  } catch (err) {
    throw new DriveNetworkError(err instanceof Error ? err.name : 'fetch failed');
  }
  if (!response.ok) {
    throw new DriveApiError(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new DriveNetworkError('unreadable answer');
  }
}

export function isDriveFile(value: unknown): value is DriveFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const id: unknown = Reflect.get(value, 'id');
  const name: unknown = Reflect.get(value, 'name');
  const parents: unknown = Reflect.get(value, 'parents');
  const driveId: unknown = Reflect.get(value, 'driveId');
  const owners: unknown = Reflect.get(value, 'owners');
  return (
    typeof id === 'string' &&
    id !== '' &&
    typeof name === 'string' &&
    (parents === undefined ||
      (Array.isArray(parents) && parents.every((parent) => typeof parent === 'string'))) &&
    (driveId === undefined || typeof driveId === 'string') &&
    (owners === undefined ||
      (Array.isArray(owners) &&
        owners.every((owner) => typeof owner === 'object' && owner !== null)))
  );
}

/** Only the fields `DRIVE_FILE_FIELDS` names are kept, whatever else the answer carried. */
function pickFile(value: DriveFile): DriveFile {
  const file: DriveFile = { id: value.id, name: value.name };
  if (value.mimeType !== undefined && typeof value.mimeType === 'string') {
    file.mimeType = value.mimeType;
  }
  if (value.parents !== undefined) {
    file.parents = [...value.parents];
  }
  if (value.driveId !== undefined) {
    file.driveId = value.driveId;
  }
  const owner = value.owners?.find((entry) => typeof entry.displayName === 'string');
  if (owner?.displayName !== undefined) {
    file.owners = [{ displayName: owner.displayName }];
  }
  return file;
}

/** `files.get` for a file or folder; `id` may be `root` for the My Drive root. */
export async function getFile(token: string, id: string, fetchImpl: FetchLike): Promise<DriveFile> {
  const params = new URLSearchParams({ fields: DRIVE_FILE_FIELDS, supportsAllDrives: 'true' });
  const body = await getJson(`${API}/files/${encodeURIComponent(id)}?${params}`, token, fetchImpl);
  if (!isDriveFile(body)) {
    throw new DriveNetworkError('unexpected files.get answer');
  }
  return pickFile(body);
}

/** `drives.get`: a shared drive's name. */
export async function getDriveName(
  token: string,
  id: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const params = new URLSearchParams({ fields: 'name' });
  const body = await getJson(`${API}/drives/${encodeURIComponent(id)}?${params}`, token, fetchImpl);
  const name: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'name') : undefined;
  if (typeof name !== 'string') {
    throw new DriveNetworkError('unexpected drives.get answer');
  }
  return name;
}

/** `about.get`: the address the token belongs to. */
export async function getAccountEmail(token: string, fetchImpl: FetchLike): Promise<string> {
  const params = new URLSearchParams({ fields: 'user(emailAddress)' });
  const body = await getJson(`${API}/about?${params}`, token, fetchImpl);
  const user: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'user') : undefined;
  const email: unknown =
    typeof user === 'object' && user !== null ? Reflect.get(user, 'emailAddress') : undefined;
  if (typeof email !== 'string' || email === '') {
    throw new DriveNetworkError('unexpected about.get answer');
  }
  return email;
}
