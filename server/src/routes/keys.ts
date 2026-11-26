import type { AppHandler, Deps } from '../context.js';
import type { KeyState } from '../db/store.js';
import { open, seal, writeVerifierOf } from '../envelope.js';
import { verifySameAccount } from '../google-auth.js';
import { error, json } from '../responses.js';
import type { GoogleIdentity, KeyEnvelope } from '../types.js';
import { parseAccessToken, parseKeysBody } from '../validation.js';

/** The verified identity, or the 403 to answer. A tagged union, so narrowing needs no `instanceof`. */
type Checked = { identity: GoogleIdentity; refusal?: undefined } | { refusal: Response };

/** The Google token must be live and of the bearer's account, or the answer is a 403. */
export async function sameAccount(
  deps: Deps,
  accessToken: string,
  googleSub: string,
): Promise<Checked> {
  const identity = await verifySameAccount(deps.verifyGoogleToken, accessToken, googleSub);
  if (identity === 'refused') {
    return { refusal: error(403, 'google_refused') };
  }
  if (identity === 'mismatch') {
    return { refusal: error(403, 'google_account_mismatch') };
  }
  return { identity };
}

/**
 * `POST /v2/keys/open`: the envelope, opened with the sub Google verified in this request as
 * associated data, never with one read from the database. Creates no account and no bearer.
 */
export function openKey(deps: Deps): AppHandler {
  return async (c) => {
    const accessToken = parseAccessToken(c.get('body'));
    if (accessToken === null) {
      return error(400, 'bad_request');
    }
    const account = c.get('account');
    const checked = await sameAccount(deps, accessToken, account.googleSub);
    if (checked.refusal !== undefined) {
      return checked.refusal;
    }
    const { identity } = checked;
    const state = await deps.store.readSealed(account.id);
    if (state.status === 'no_account') {
      return error(401, 'unauthorized');
    }
    if (state.status === 'no_key') {
      return error(409, 'key_missing');
    }
    const envelope = await open(deps.keyEncryptionKey, state.row, identity.sub);
    if (envelope === null) {
      // Another key encryption key, another sub, or an edited row: never regenerated, never written.
      console.error('tabinet-server: an envelope did not open');
      return error(500, 'key_unavailable');
    }
    return json(200, { envelope });
  };
}

/** Why a key write changed nothing (spec 4.3), from the row as it is now. */
function keyWriteRefusal(state: KeyState, envelope: KeyEnvelope, verifier: string): Response {
  if (state === null) {
    return error(401, 'unauthorized');
  }
  if (state.keyId === null) {
    // No key: a create of generation 1 failed only because records exist without a key, which is
    // a damaged row.
    return envelope.generation === 1 ? error(500, 'internal') : error(409, 'key_missing');
  }
  if (envelope.generation === 1) {
    return error(409, 'key_exists');
  }
  if (state.keyId !== envelope.keyId) {
    return error(409, 'key_mismatch');
  }
  if (state.writeVerifier !== verifier) {
    return error(403, 'proof_invalid');
  }
  return error(409, 'generation_conflict');
}

/**
 * `PUT /v2/keys`: creates the key (201) or replaces its envelope (200) with one conditional
 * UPDATE. A replace needs the same key id, the write proof only the data key gives, and the
 * generation one above the stored one, so a Google token without the data key cannot replace it.
 * Opening is not needed, so a lost or rotated key encryption key is repaired by an ordinary change.
 */
export function putKey(deps: Deps): AppHandler {
  return async (c) => {
    const body = parseKeysBody(c.get('body'));
    if (body === null) {
      return error(400, 'bad_request');
    }
    const account = c.get('account');
    const checked = await sameAccount(deps, body.accessToken, account.googleSub);
    if (checked.refusal !== undefined) {
      return checked.refusal;
    }
    const { identity } = checked;
    const { envelope } = body;
    const writeVerifier = writeVerifierOf(body.proof);
    const key = await deps.store.writeKey(account.id, identity.sub, {
      keyId: envelope.keyId,
      generation: envelope.generation,
      writeVerifier,
      keyEncryptionKeyId: deps.keyEncryptionKey.id,
      sealed: await seal(deps.keyEncryptionKey, identity.sub, envelope),
    });
    if (key !== null) {
      return json(envelope.generation === 1 ? 201 : 200, { key });
    }
    return keyWriteRefusal(await deps.store.readKeyState(account.id), envelope, writeVerifier);
  };
}
