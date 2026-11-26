/** The three editors whose title bar gets a folder path. */
export type DocKind = 'document' | 'spreadsheets' | 'presentation';

/** A Docs, Sheets or Slides file as its address names it. */
export interface DocRef {
  kind: DocKind;
  fileId: string;
  /** The `/u/<n>/` account index of the address, when it has one. */
  accountIndex?: number;
}

/** Which Google account the open page uses, as far as the page tells. */
export interface AccountHint {
  /** The `/u/<n>/` index. */
  index?: number;
  /** The signed-in address the page shows, when it could be read. */
  email?: string;
}

/** One file or folder as Drive API v3 returns it with `DRIVE_FILE_FIELDS`. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  driveId?: string;
  owners?: { displayName?: string }[];
}

/** One step of a path: the My Drive root, a shared drive, or a folder. */
export interface PathSegment {
  id: string;
  name: string;
  kind: 'my-drive' | 'shared-drive' | 'folder';
}

/** Where a file lives, as far as the signed-in account can see. */
export type DrivePath =
  | {
      kind: 'path';
      /** Outermost first. */
      segments: PathSegment[];
      /** True when an ancestor above the first segment could not be read. */
      partial: boolean;
    }
  | {
      kind: 'hidden';
      /** The owner's display name, when Drive gave one. */
      owner?: string;
    };

export type PathErrorReason = 'network' | 'wrong-account' | 'cancelled' | 'unknown';

/** The worker's answer to a content script asking for a file's path. */
export type PathAnswer =
  | { state: 'not-configured' }
  | { state: 'needs-sign-in' }
  | { state: 'ready'; path: DrivePath }
  | { state: 'error'; reason: PathErrorReason };

/** A signed-in account's token, kept in `chrome.storage.session` only. */
export interface StoredToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The address Drive reported for the token. */
  email: string;
}
