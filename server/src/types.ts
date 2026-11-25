// Protocol v2. The shapes from "Shared shapes" of the v10 spec, declared verbatim here and in the
// extension's src/types.ts; neither side imports the other's.

export type WireKey = { keyId: string; generation: number } | null;
export interface Usage {
  bytes: number;
  screenshots: number;
}
export type RecordKind = 'session' | 'settings' | 'image' | 'doc';
export interface RecordOut {
  kind: RecordKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
  iv: string;
  ciphertext: string;
  seq: number;
}
export type RecordIn = Omit<RecordOut, 'seq'> & { baseSeq?: number | null }; // baseSeq: required on doc, absent otherwise
export type WriteResult = { kind: RecordKind; id: string } & (
  | { status: 'applied'; seq: number }
  | { status: 'absent' } // a deletion of a row the server lacks, over the cap: nothing stored, settled
  | { status: 'stale'; current: RecordOut | null } // null only for doc: no row
  | { status: 'stale'; withheld: true } // current not sent, the answer would be too large
  | { status: 'rejected'; reason: 'image_limit' | 'storage_limit' }
  | { status: 'rejected'; reason: 'clock_ahead' }
);
export type PullLine =
  | { type: 'start'; keyId: string; since: number; through: number; usage: Usage }
  | { type: 'record'; record: RecordOut }
  | { type: 'checkpoint'; cursor: number; count: number }
  | { type: 'end'; cursor: number; complete: boolean };
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'google_refused'
  | 'google_account_mismatch'
  | 'proof_invalid'
  | 'not_found'
  | 'method_not_allowed'
  | 'key_exists'
  | 'key_missing'
  | 'key_mismatch'
  | 'generation_conflict'
  | 'upgrade_required'
  | 'payload_too_large'
  | 'key_unavailable'
  | 'internal'
  | 'google_unavailable';

/** The key envelope a device sends and gets back (spec 3.3). The server only seals and opens it. */
export interface KeyEnvelope {
  v: 2;
  generation: number; // integer 1..2147483647
  keyId: string; // b64u of 16 bytes
  salt: string; // b64 of 16 bytes
  iv: string; // b64 of 12 bytes
  wrapped: string; // b64 of 48 bytes: AES-GCM(wrapKey, iv, dek)
}

/** The kinds of record, in the order the database's CHECK lists them. */
export const RECORD_KINDS: readonly RecordKind[] = ['session', 'settings', 'image', 'doc'];

/** The account a bearer token belongs to, as the bearer lookup reads it. */
export interface Account {
  id: string;
  googleSub: string;
  email: string;
  key: WireKey;
  usage: Usage;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
}
