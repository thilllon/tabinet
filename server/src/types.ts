/** The kinds of record a client may store. Anything else is refused with 400. */
export const RECORD_KINDS = ['session', 'settings', 'notes', 'image'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/**
 * The kinds `GET /v1/records` lists when the request names none: the ones every client version
 * understands. A version from before notes would refuse a page holding a kind it does not know, so
 * `notes` and `image` records are listed only to a client that asks for them (`kinds=`).
 */
export const DEFAULT_LISTED_KINDS: readonly RecordKind[] = ['session', 'settings'];

/** What a device needs to derive the encryption key from the passphrase and check it. */
export interface KeySetup {
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  salt: string;
  check: string;
  checkIv: string;
}

export interface User {
  id: string;
  email: string;
  keySetup: KeySetup | null;
}

/** A record as a client sends it. The server never sees what is inside `ciphertext`. */
export interface RecordInput {
  kind: RecordKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
  iv: string;
  ciphertext: string;
}

/** A stored record, with the sequence number of the write that last changed it. */
export interface StoredRecord extends RecordInput {
  seq: number;
}

/** Why a write was refused without being stale. */
export type RejectReason = 'image_limit';

export type ApplyResult =
  | { status: 'applied'; seq: number }
  | { status: 'stale'; current: StoredRecord }
  | { status: 'rejected'; reason: RejectReason };

export interface GoogleIdentity {
  sub: string;
  email: string;
}
