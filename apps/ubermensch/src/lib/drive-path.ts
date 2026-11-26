import { POLICY } from '@/constants';
import type { DriveFile, DrivePath, PathSegment } from '@/types';

/**
 * Walks a file's parents up to My Drive or its shared drive. Pure: the Drive calls come in as
 * `deps`, which return `undefined` for a file or folder the account cannot see (403 / 404) and
 * throw for anything else (no token, network), which ends the walk.
 */
export interface PathDeps {
  getFile(id: string): Promise<DriveFile | undefined>;
  getDriveName(driveId: string): Promise<string | undefined>;
  /** The id of this account's My Drive root folder. */
  getRootId(): Promise<string | undefined>;
}

function ownerOf(file: DriveFile): string | undefined {
  const name = file.owners?.find((owner) => (owner.displayName ?? '') !== '')?.displayName;
  return name === undefined ? undefined : name;
}

function hidden(file: DriveFile | undefined): DrivePath {
  const owner = file === undefined ? undefined : ownerOf(file);
  return owner === undefined ? { kind: 'hidden' } : { kind: 'hidden', owner };
}

async function sharedDriveSegment(driveId: string, deps: PathDeps): Promise<PathSegment> {
  // A shared drive whose name cannot be read still shows as one (named in the UI's language).
  const name = (await deps.getDriveName(driveId)) ?? '';
  return { id: driveId, name, kind: 'shared-drive' };
}

/** Where `fileId` lives, as far as the account can see. */
export async function resolvePath(fileId: string, deps: PathDeps): Promise<DrivePath> {
  const file = await deps.getFile(fileId);
  if (file === undefined) {
    return hidden(undefined);
  }
  const firstParent = file.parents?.[0];
  if (firstParent === undefined) {
    // In a shared drive every file has a parent, so this is a file shared with the account that
    // was never added to its Drive: its location is someone else's.
    return hidden(file);
  }

  const segments: PathSegment[] = [];
  let current: string = firstParent;
  for (let depth = 0; depth < POLICY.path.maxDepth; depth += 1) {
    if (file.driveId !== undefined && current === file.driveId) {
      segments.unshift(await sharedDriveSegment(file.driveId, deps));
      return { kind: 'path', segments, partial: false };
    }
    const folder = await deps.getFile(current);
    if (folder === undefined) {
      // The parent itself is out of reach: there is no path to show, only who owns the file.
      return segments.length === 0 ? hidden(file) : { kind: 'path', segments, partial: true };
    }
    const next = folder.parents?.[0];
    if (next === undefined) {
      if (folder.driveId !== undefined) {
        segments.unshift(await sharedDriveSegment(folder.driveId, deps));
        return { kind: 'path', segments, partial: false };
      }
      if (folder.id === (await deps.getRootId())) {
        segments.unshift({ id: folder.id, name: folder.name, kind: 'my-drive' });
        return { kind: 'path', segments, partial: false };
      }
      // A folder shared with the account: its own parents belong to someone else.
      segments.unshift({ id: folder.id, name: folder.name, kind: 'folder' });
      return { kind: 'path', segments, partial: true };
    }
    segments.unshift({ id: folder.id, name: folder.name, kind: 'folder' });
    current = next;
  }
  return { kind: 'path', segments, partial: true };
}
