-- Protocol v2. Deliberately destructive: no v1 row is carried over. The table names are new, so
-- every statement of every deployment built before v2 fails instead of reading or writing.
-- Never edit this file after it has run on production.

LOCK TABLE users, auth_tokens, records IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF (EXISTS (SELECT 1 FROM users))
     AND current_setting('tabinet.wipe_v1', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION '003 deletes every v1 account: run migrate with WIPE_V1=yes';
  END IF;
END
$$;

DROP FUNCTION apply_image_record(uuid, text, bigint, boolean, text, text, integer);
DROP TABLE records, auth_tokens, users;
DROP SEQUENCE record_seq;

CREATE SEQUENCE account_record_seq AS bigint;

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
  email text NOT NULL,
  key_id text CHECK (key_id ~ '^[A-Za-z0-9_-]{22}$'),
  key_generation integer CHECK (key_generation >= 1),
  -- sha256 of the write proof, lowercase hex. The proof itself is never stored.
  write_verifier text CHECK (write_verifier ~ '^[0-9a-f]{64}$'),
  key_encryption_key_id text CHECK (key_encryption_key_id ~ '^[0-9a-f]{16}$'),
  -- base64 of iv(12) || AES-256-GCM(envelope(97)) || tag(16): 125 bytes.
  sealed_envelope text CHECK (length(sealed_envelope) = 168),
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  screenshots integer NOT NULL DEFAULT 0 CHECK (screenshots >= 0),
  last_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_key_whole CHECK (
    num_nonnulls(key_id, key_generation, write_verifier, key_encryption_key_id, sealed_envelope) IN (0, 5)
  )
);

CREATE TABLE account_tokens (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_tokens_account_id ON account_tokens (account_id);

CREATE TABLE account_records (
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('session', 'settings', 'image', 'doc')),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  updated_at bigint NOT NULL CHECK (updated_at >= 0),
  deleted boolean NOT NULL,
  iv text NOT NULL,
  ciphertext text NOT NULL,
  -- What this row counts against the account, computed by the server from POLICY.
  stored_bytes integer NOT NULL CHECK (stored_bytes > 0),
  seq bigint NOT NULL,
  PRIMARY KEY (account_id, kind, id),
  CHECK (kind <> 'doc' OR id ~ '^[A-Za-z0-9_-]{43}$'),
  CHECK (kind <> 'settings' OR (id = 'settings' AND NOT deleted))
);

CREATE UNIQUE INDEX account_records_seq
  ON account_records (account_id, seq) INCLUDE (stored_bytes);

-- One write. VOLATILE plpgsql under READ COMMITTED: after the account row is locked, every
-- statement sees what committed while this one waited, so caps and compare-and-swap are exact,
-- and an account's seq order is its commit order.
CREATE FUNCTION apply_account_record(
  p_account uuid,
  p_key_id text,
  p_kind text,
  p_id text,
  p_updated_at bigint,
  p_deleted boolean,
  p_iv text,
  p_ciphertext text,
  p_base_seq bigint,
  p_stored_bytes integer,
  p_storage_limit bigint,
  p_screenshot_limit integer
) RETURNS TABLE (outcome text, new_seq bigint)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  account_key text;
  used_bytes bigint;
  used_shots integer;
  old_updated_at bigint;
  old_deleted boolean;
  old_bytes integer;
  old_seq bigint;
  byte_delta bigint;
  shot_delta integer;
BEGIN
  SELECT a.key_id, a.storage_bytes, a.screenshots
    INTO account_key, used_bytes, used_shots
    FROM accounts a WHERE a.id = p_account FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    outcome := 'no_account'; RETURN NEXT; RETURN;
  END IF;
  IF account_key IS NULL THEN
    outcome := 'key_missing'; RETURN NEXT; RETURN;
  END IF;
  IF account_key IS DISTINCT FROM p_key_id THEN
    outcome := 'key_mismatch'; RETURN NEXT; RETURN;
  END IF;

  SELECT r.updated_at, r.deleted, r.stored_bytes, r.seq
    INTO old_updated_at, old_deleted, old_bytes, old_seq
    FROM account_records r
    WHERE r.account_id = p_account AND r.kind = p_kind AND r.id = p_id;

  IF (p_kind = 'doc' AND p_base_seq IS DISTINCT FROM old_seq)
     OR old_updated_at >= p_updated_at THEN
    outcome := 'stale'; RETURN NEXT; RETURN;
  END IF;

  byte_delta := p_stored_bytes::bigint - coalesce(old_bytes, 0);
  shot_delta := CASE WHEN p_kind = 'image' THEN
    (NOT p_deleted)::integer - (NOT coalesce(old_deleted, true))::integer ELSE 0 END;

  IF p_deleted THEN
    -- A tombstone over an existing row always applies. One for a row that never existed is kept
    -- only while it fits, so invented tombstones cannot grow an account without end.
    IF old_seq IS NULL AND used_bytes + byte_delta > p_storage_limit THEN
      outcome := 'absent'; RETURN NEXT; RETURN;
    END IF;
  ELSE
    IF shot_delta > 0 AND used_shots + shot_delta > p_screenshot_limit THEN
      outcome := 'image_limit'; RETURN NEXT; RETURN;
    END IF;
    IF byte_delta > 0 AND used_bytes + byte_delta > p_storage_limit THEN
      outcome := 'storage_limit'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  new_seq := nextval('account_record_seq');
  INSERT INTO account_records AS r
    (account_id, kind, id, updated_at, deleted, iv, ciphertext, stored_bytes, seq)
  VALUES
    (p_account, p_kind, p_id, p_updated_at, p_deleted, p_iv, p_ciphertext, p_stored_bytes, new_seq)
  ON CONFLICT ON CONSTRAINT account_records_pkey DO UPDATE SET
    updated_at = EXCLUDED.updated_at,
    deleted = EXCLUDED.deleted,
    iv = EXCLUDED.iv,
    ciphertext = EXCLUDED.ciphertext,
    stored_bytes = EXCLUDED.stored_bytes,
    seq = EXCLUDED.seq;
  UPDATE accounts a SET
    storage_bytes = a.storage_bytes + byte_delta,
    screenshots = a.screenshots + shot_delta,
    last_seq = new_seq
  WHERE a.id = p_account;

  outcome := 'applied';
  RETURN NEXT;
END
$$;
