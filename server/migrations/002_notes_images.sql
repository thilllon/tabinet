-- YouTube notes (GitHub issue #221): two more kinds of record. A `notes` record holds one video's
-- notes (id = the YouTube video id) and an `image` record one screenshot (id = the image id), both
-- encrypted like every other record: the server never sees a note, a title or a picture.

ALTER TABLE records DROP CONSTRAINT records_kind_check;
ALTER TABLE records
  ADD CONSTRAINT records_kind_check CHECK (kind IN ('session', 'settings', 'notes', 'image'));

-- Counts a user's live screenshots quickly for the per-account cap.
CREATE INDEX records_live_images ON records (user_id) WHERE kind = 'image' AND NOT deleted;

-- Last writer wins for one image record, with a cap on the live image records of a user: a write
-- that would add one more live image while the user already has `p_limit` is refused
-- ('rejected'). A tombstone, and a write to an image that is already live, are never refused.
--
-- A function rather than one statement, because the count must see every write committed before
-- it: it first takes the user's row lock (the same lock every record write takes, so a user's
-- writes still run one at a time and commit in seq order), and each statement after it runs with a
-- fresh snapshot (READ COMMITTED, a VOLATILE function), so no write that committed while this one
-- waited for the lock is missed. One statement's subquery would count with the snapshot it took
-- before the wait, and two writers could then both take the last place.
--
-- Answers one row: ('applied', seq), ('stale', NULL) or ('rejected', NULL); no row at all when
-- the user does not exist.
CREATE FUNCTION apply_image_record(
  p_user uuid,
  p_id text,
  p_updated_at bigint,
  p_deleted boolean,
  p_iv text,
  p_ciphertext text,
  p_limit integer
) RETURNS TABLE (outcome text, new_seq bigint)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  stored_updated_at bigint;
  stored_deleted boolean;
  live_images integer;
BEGIN
  PERFORM 1 FROM users WHERE id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT r.updated_at, r.deleted INTO stored_updated_at, stored_deleted
    FROM records r WHERE r.user_id = p_user AND r.kind = 'image' AND r.id = p_id;
  IF stored_updated_at IS NOT NULL AND stored_updated_at >= p_updated_at THEN
    outcome := 'stale';
    new_seq := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT p_deleted AND (stored_deleted IS NULL OR stored_deleted) THEN
    SELECT count(*) INTO live_images
      FROM records r WHERE r.user_id = p_user AND r.kind = 'image' AND NOT r.deleted;
    IF live_images >= p_limit THEN
      outcome := 'rejected';
      new_seq := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  INSERT INTO records AS r (user_id, kind, id, updated_at, deleted, iv, ciphertext, seq)
  VALUES (p_user, 'image', p_id, p_updated_at, p_deleted, p_iv, p_ciphertext, nextval('record_seq'))
  ON CONFLICT (user_id, kind, id) DO UPDATE SET
    updated_at = EXCLUDED.updated_at,
    deleted = EXCLUDED.deleted,
    iv = EXCLUDED.iv,
    ciphertext = EXCLUDED.ciphertext,
    seq = nextval('record_seq')
  RETURNING r.seq INTO new_seq;
  outcome := 'applied';
  RETURN NEXT;
END
$$;
