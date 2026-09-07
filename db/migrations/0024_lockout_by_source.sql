-- 0024 — Lockout keyed on (account, source), not on the account alone.
--
-- Five failures then fifteen minutes is right for the honest 6am subcontractor.
-- Keyed on the account alone it is also a denial-of-service primitive: anyone
-- who knows a foreman's email address can lock them out of the system on the
-- morning of a pour, repeatedly, for free, from anywhere. The attacker needs no
-- credential and no access -- only the address, which is on every transmittal.
--
-- The failed-authentication record already exists, so the signal is there. What
-- changes is how it is counted:
--
--   * Per (account, source) -- a hard lock. An attacker from one origin cannot
--     lock out the legitimate origin, because the counters are separate.
--   * Per account -- a PROGRESSIVE DELAY rather than a lock. Sustained failure
--     across many origins still costs the attacker time, and a distributed
--     attempt is slowed, but the real user is never refused outright.
--
-- The distinction matters: a delay degrades, a lock denies. Denying is the thing
-- an attacker wants.

CREATE TABLE auth_failure_counter (
  user_id        uuid        NOT NULL REFERENCES user_account(id),
  -- A coarse origin key: the source address, or a stable device/client id where
  -- one is available. Deliberately not fine-grained -- an attacker rotating
  -- addresses should still accumulate account-level delay.
  source_key     text        NOT NULL,
  failed_count   int         NOT NULL DEFAULT 0,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at  timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  PRIMARY KEY (user_id, source_key)
);
CREATE INDEX auth_failure_counter_recent ON auth_failure_counter (user_id, last_failed_at DESC);

ALTER TABLE auth_failure_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_failure_counter FORCE ROW LEVEL SECURITY;
-- No permissive policy: like auth_credential, this is reached only by the
-- privileged authentication path, which runs before there is an identity.

COMMENT ON TABLE auth_failure_counter IS
  'Failed authentication counters keyed on (account, source). A hard lock applies per source; the account itself only ever accrues a progressive delay, so an attacker who knows an address cannot deny that account service.';

/**
 * Records a failure and returns the resulting posture for this (account, source).
 *
 * Returns the source lock (if any) and the account-wide delay in seconds, which
 * the caller applies before answering. The delay is bounded: its job is to make
 * a distributed attempt expensive, not to become the denial it replaces.
 */
CREATE OR REPLACE FUNCTION auth.register_auth_failure(
  p_user_id    uuid,
  p_source_key text,
  p_max_source_failures int DEFAULT 5,
  p_lockout    interval DEFAULT interval '15 minutes'
) RETURNS TABLE (source_locked_until timestamptz, account_delay_seconds numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_count   int;
  v_lock    timestamptz;
  v_recent  int;
BEGIN
  INSERT INTO auth_failure_counter (user_id, source_key, failed_count)
  VALUES (p_user_id, COALESCE(nullif(btrim(p_source_key), ''), 'unknown'), 1)
  ON CONFLICT (user_id, source_key) DO UPDATE
    SET failed_count = CASE
          -- A quiet hour resets the source counter: a genuine user who mistyped
          -- last week should not start today one attempt from a lockout.
          WHEN auth_failure_counter.last_failed_at < now() - interval '1 hour' THEN 1
          ELSE auth_failure_counter.failed_count + 1 END,
        last_failed_at = now()
  RETURNING failed_count INTO v_count;

  IF v_count >= p_max_source_failures THEN
    v_lock := now() + p_lockout;
    UPDATE auth_failure_counter SET locked_until = v_lock
     WHERE user_id = p_user_id AND source_key = COALESCE(nullif(btrim(p_source_key),''),'unknown');
  END IF;

  -- Account-wide: how many distinct sources have failed against this account
  -- recently. Many sources is the signature of a spray, and it buys delay, not
  -- denial.
  SELECT count(*)::int INTO v_recent
    FROM auth_failure_counter
   WHERE user_id = p_user_id AND last_failed_at > now() - interval '1 hour';

  RETURN QUERY SELECT
    v_lock,
    -- 0, 0.5, 1, 2, 4 ... capped at 8 seconds.
    LEAST(8, CASE WHEN v_recent <= 1 THEN 0 ELSE power(2, LEAST(v_recent - 2, 4)) / 2 END)::numeric;
END $$;

/** Current posture for a (account, source) pair, without recording a failure. */
CREATE OR REPLACE FUNCTION auth.auth_failure_posture(p_user_id uuid, p_source_key text)
RETURNS TABLE (source_locked_until timestamptz, account_delay_seconds numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT
    (SELECT locked_until FROM auth_failure_counter
      WHERE user_id = p_user_id
        AND source_key = COALESCE(nullif(btrim(p_source_key),''),'unknown')
        AND locked_until > now()),
    LEAST(8, CASE WHEN c.n <= 1 THEN 0 ELSE power(2, LEAST(c.n - 2, 4)) / 2 END)::numeric
  FROM (SELECT count(*)::int n FROM auth_failure_counter
         WHERE user_id = p_user_id AND last_failed_at > now() - interval '1 hour') c;
$$;

/** Clears the source counter on a successful sign-in. */
CREATE OR REPLACE FUNCTION auth.clear_auth_failures(p_user_id uuid, p_source_key text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, auth AS $$
  DELETE FROM auth_failure_counter
   WHERE user_id = p_user_id
     AND source_key = COALESCE(nullif(btrim(p_source_key),''),'unknown');
$$;

-- auth_credential.locked_until stays for compatibility but is no longer the
-- gate: the source-keyed counter is. Leaving a second, account-wide lock in
-- place would reintroduce exactly the denial this migration removes.
COMMENT ON COLUMN auth_credential.locked_until IS
  'Legacy account-wide lock. NOT the gate -- see auth_failure_counter (0024). Retained so historical values are not lost.';
