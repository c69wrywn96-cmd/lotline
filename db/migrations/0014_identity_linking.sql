-- 0014 — Account linking: a deliberate migration path between authentication
-- patterns.
--
-- The runtime rule in src/auth/home-realm.ts is right — a user recorded as
-- local_credentials is never re-routed because their employer's domain later
-- appears on an identity provider. But a rule with no exit is a one-way door: a
-- ten-person subcontractor gets acquired, or federates, and their people are
-- stuck on PINs and TOTP forever, accumulating a permanent shadow estate of
-- local accounts that nobody can retire.
--
-- The exit is explicit, three-party and auditable:
--   1. A contractor admin INITIATES the link. They cannot complete it.
--   2. The USER VERIFIES from the federated side, proving control of the
--      account at the new provider. Nobody else can do this step.
--   3. Completion retires the old credential -- retired, never deleted
--      (ADR-0003) -- and both identities remain attached to one user record.
--
-- Never automatic. Never triggered by domain discovery. There is no trigger
-- anywhere in this file, deliberately: nothing observes org_identity_provider
-- and re-points users at it.

ALTER TABLE auth_credential ADD COLUMN retired_at timestamptz;
ALTER TABLE auth_credential ADD COLUMN retire_reason text;
COMMENT ON COLUMN auth_credential.retired_at IS
  'A retired credential can no longer authenticate but is never deleted: the audit trail must still show the account existed and how it was migrated.';

CREATE TABLE identity_link_request (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id             uuid        NOT NULL REFERENCES user_account(id),
  from_pattern        text        NOT NULL
                      CHECK (from_pattern IN ('home_tenant','federated_oidc','guest_b2b','local_credentials')),
  to_pattern          text        NOT NULL
                      CHECK (to_pattern IN ('home_tenant','federated_oidc','guest_b2b','local_credentials')),
  target_idp_id       uuid        REFERENCES org_identity_provider(id),
  status              text        NOT NULL DEFAULT 'initiated'
                      CHECK (status IN ('initiated','verified','completed','cancelled','expired','rejected')),
  -- Only the hash is stored. The plaintext is returned once, at initiation.
  verification_hash   text        NOT NULL,
  initiated_by        uuid        NOT NULL REFERENCES user_account(id),
  initiated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  verified_at         timestamptz,
  verified_subject    text,
  verified_email      citext,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid        REFERENCES user_account(id),
  cancel_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT federated_target_needs_idp CHECK (
    (to_pattern = 'federated_oidc') = (target_idp_id IS NOT NULL)
  ),
  CONSTRAINT pattern_actually_changes CHECK (from_pattern <> to_pattern),
  CONSTRAINT cancelled_has_reason CHECK (
    status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);

-- At most one live request per user: two concurrent migrations would race to
-- retire the same credential.
CREATE UNIQUE INDEX identity_link_request_one_open
  ON identity_link_request (user_id) WHERE status IN ('initiated','verified');
CREATE INDEX identity_link_request_user ON identity_link_request (user_id);

-- ---------------------------------------------------------------------------
-- Step 1 — an administrator initiates. They cannot complete it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.initiate_identity_link(
  p_user_id       uuid,
  p_to_pattern    text,
  p_target_idp_id uuid DEFAULT NULL,
  p_ttl           interval DEFAULT interval '7 days'
) RETURNS TABLE (request_id uuid, verification_token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  u      record;
  idp    record;
  token  text;
  authorised boolean;
BEGIN
  SELECT * INTO u FROM user_account WHERE id = p_user_id AND superseded_by_id IS NULL;
  IF u IS NULL THEN RAISE EXCEPTION 'LOTLINE_LINK_USER_MISSING'; END IF;

  -- The initiator must administer users on a project the subject belongs to.
  SELECT EXISTS (
    SELECT 1 FROM project_membership pm
     WHERE pm.user_id = p_user_id
       AND pm.active_period @> CURRENT_DATE
       AND auth.has_permission('admin.users.manage', pm.project_id)
  ) INTO authorised;
  IF NOT authorised THEN
    RAISE EXCEPTION 'LOTLINE_LINK_NOT_AUTHORISED: initiating an account link requires admin.users.manage on a project the user belongs to';
  END IF;

  -- Changing how someone authenticates is exactly as consequential as a hold
  -- point release, and is held to the same bar.
  IF auth.strength_rank(auth.auth_strength()) < auth.strength_rank('step_up') THEN
    RAISE EXCEPTION 'LOTLINE_LINK_STEP_UP_REQUIRED';
  END IF;

  IF p_to_pattern = 'federated_oidc' THEN
    SELECT * INTO idp FROM org_identity_provider WHERE id = p_target_idp_id;
    IF idp IS NULL OR idp.status <> 'active' THEN
      RAISE EXCEPTION 'LOTLINE_LINK_IDP_NOT_ACTIVE';
    END IF;
  END IF;

  token := encode(gen_random_bytes(32), 'hex');

  RETURN QUERY
  INSERT INTO identity_link_request
    (user_id, from_pattern, to_pattern, target_idp_id, verification_hash,
     initiated_by, expires_at)
  VALUES
    (p_user_id, u.auth_pattern, p_to_pattern, p_target_idp_id,
     encode(digest(token, 'sha256'), 'hex'), auth.user_id(), now() + p_ttl)
  RETURNING id, token;
END $$;

-- ---------------------------------------------------------------------------
-- Step 2 — the USER verifies, from the federated side. Nobody else can.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.verify_identity_link(
  p_request_id uuid,
  p_token      text,
  p_subject    text,
  p_email      citext,
  p_issuer     text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE r record; u record; idp record; clash uuid;
BEGIN
  SELECT * INTO r FROM identity_link_request WHERE id = p_request_id;
  IF r IS NULL THEN RAISE EXCEPTION 'LOTLINE_LINK_MISSING'; END IF;
  IF r.status <> 'initiated' THEN
    RAISE EXCEPTION 'LOTLINE_LINK_WRONG_STATE: request is %', r.status;
  END IF;
  IF now() > r.expires_at THEN
    UPDATE identity_link_request SET status = 'expired', updated_at = now() WHERE id = r.id;
    RAISE EXCEPTION 'LOTLINE_LINK_EXPIRED';
  END IF;
  IF encode(digest(p_token, 'sha256'), 'hex') IS DISTINCT FROM r.verification_hash THEN
    RAISE EXCEPTION 'LOTLINE_LINK_BAD_TOKEN';
  END IF;

  SELECT * INTO u FROM user_account WHERE id = r.user_id;

  -- The federated account must be demonstrably the same person. Matching on the
  -- address is what makes this a LINK rather than an account transfer.
  IF lower(p_email::text) IS DISTINCT FROM lower(u.email::text) THEN
    RAISE EXCEPTION
      'LOTLINE_LINK_EMAIL_MISMATCH: the federated account (%) is not the account being linked (%)',
      p_email, u.email;
  END IF;

  IF r.target_idp_id IS NOT NULL THEN
    SELECT * INTO idp FROM org_identity_provider WHERE id = r.target_idp_id;
    IF idp.status <> 'active' THEN RAISE EXCEPTION 'LOTLINE_LINK_IDP_NOT_ACTIVE'; END IF;
    IF p_issuer IS NOT NULL AND p_issuer IS DISTINCT FROM idp.issuer THEN
      RAISE EXCEPTION 'LOTLINE_LINK_ISSUER_MISMATCH';
    END IF;
  END IF;

  -- A subject already bound to a DIFFERENT user is an account-takeover vector:
  -- it would let one federated identity absorb a second local account.
  SELECT ai.user_id INTO clash FROM auth_identity ai
   WHERE ai.subject = p_subject AND ai.revoked_at IS NULL AND ai.user_id <> r.user_id
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_LINK_SUBJECT_TAKEN: that federated identity already belongs to another account';
  END IF;

  UPDATE identity_link_request
     SET status = 'verified', verified_at = now(),
         verified_subject = p_subject, verified_email = p_email, updated_at = now()
   WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- Step 3 — completion. Retires, never deletes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.complete_identity_link(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM identity_link_request WHERE id = p_request_id;
  IF r IS NULL THEN RAISE EXCEPTION 'LOTLINE_LINK_MISSING'; END IF;
  IF r.status <> 'verified' THEN
    RAISE EXCEPTION 'LOTLINE_LINK_NOT_VERIFIED: the user must verify from the target provider first (status is %)', r.status;
  END IF;

  -- The new identity.
  INSERT INTO auth_identity (user_id, provider, org_identity_provider_id, subject)
  VALUES (r.user_id,
          CASE WHEN r.to_pattern = 'federated_oidc' THEN 'oidc_federated'
               WHEN r.to_pattern = 'local_credentials' THEN 'local'
               WHEN r.to_pattern = 'guest_b2b' THEN 'entra_guest'
               ELSE 'entra_home' END,
          r.target_idp_id, r.verified_subject);

  -- Retire the old routes. Both identities stay attached to the one user record;
  -- the old one simply can no longer authenticate.
  UPDATE auth_identity SET revoked_at = now()
   WHERE user_id = r.user_id AND revoked_at IS NULL
     AND subject IS DISTINCT FROM r.verified_subject;

  IF r.from_pattern = 'local_credentials' THEN
    UPDATE auth_credential
       SET retired_at = now(),
           retire_reason = format('migrated to %s via identity_link_request %s', r.to_pattern, r.id)
     WHERE user_id = r.user_id AND retired_at IS NULL;
    UPDATE auth_totp SET revoked_at = now()
     WHERE user_id = r.user_id AND revoked_at IS NULL;
  END IF;

  UPDATE user_account SET auth_pattern = r.to_pattern, updated_at = now()
   WHERE id = r.user_id;

  UPDATE identity_link_request
     SET status = 'completed', completed_at = now(), updated_at = now()
   WHERE id = r.id;
END $$;

CREATE OR REPLACE FUNCTION auth.cancel_identity_link(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM identity_link_request WHERE id = p_request_id;
  IF r IS NULL THEN RAISE EXCEPTION 'LOTLINE_LINK_MISSING'; END IF;
  IF r.status NOT IN ('initiated','verified') THEN
    RAISE EXCEPTION 'LOTLINE_LINK_WRONG_STATE: request is %', r.status;
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'LOTLINE_LINK_REASON_REQUIRED';
  END IF;
  UPDATE identity_link_request
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.user_id(),
         cancel_reason = p_reason, updated_at = now()
   WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- RLS and audit
-- ---------------------------------------------------------------------------
ALTER TABLE identity_link_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_link_request FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_link_request_select ON identity_link_request
  FOR SELECT TO lotline_app, lotline_worker
  USING (
    user_id = auth.user_id()
    OR initiated_by = auth.user_id()
    OR EXISTS (
      SELECT 1 FROM project_membership pm
       WHERE pm.user_id = identity_link_request.user_id
         AND auth.has_permission('admin.users.manage', pm.project_id)
    )
  );
-- No INSERT or UPDATE policy: the table is written only through the guarded
-- SECURITY DEFINER functions above.

SELECT audit.attach('identity_link_request');
SELECT audit.attach('auth_credential');

SELECT public.revoke_delete_everywhere();

INSERT INTO permission (code, resource, action, description, min_auth_strength, device_bound_allowed)
VALUES ('admin.identity_link.initiate','admin','identity_link.initiate',
        'Initiate an account link between authentication patterns','step_up',false);

SELECT public.grant_role('QM', 'admin.identity_link.initiate');
SELECT public.grant_role('PD', 'admin.identity_link.initiate');
