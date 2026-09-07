-- 0002 — Domain A, part 2: trusted devices and per-user unlock (ADR-0021,
-- pattern 4).
--
-- Site tablets are shared. A foreman will not complete an MFA challenge thirty
-- times a shift. So the DEVICE is enrolled once as trusted by an authorised user
-- under full MFA — that enrolment is the strong authentication the whole pattern
-- rests on — and thereafter each user unlocks with a PIN or platform passkey.
--
-- The PIN maps to a USER IDENTITY, not to the device. It is binding a signature.
-- A user's first unlock on a device requires their own full authentication,
-- recorded as enrolment_auth_event_id, so a PIN can never assert an identity
-- that has not been independently verified.

-- ---------------------------------------------------------------------------
-- Authentication events: every authentication and unlock, with its strength.
-- Insert-only. signature.authentication_event_id will point here, giving the
-- chain: signature <- unlock <- that user's enrolment <- the MFA login.
-- ---------------------------------------------------------------------------
CREATE TABLE authentication_event (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id             uuid        NOT NULL REFERENCES user_account(id),
  device_id           uuid,       -- FK added below, after device exists
  method              text        NOT NULL
                      CHECK (method IN ('idp_primary','idp_reauth','password_totp',
                                        'device_pin','device_passkey','passkey',
                                        'recovery_code')),
  -- The three strength levels from 03-permission-matrix.md §10.
  strength            text        NOT NULL
                      CHECK (strength IN ('session','device_unlock','step_up')),
  mfa_satisfied       boolean     NOT NULL DEFAULT false,
  device_bound_session boolean    NOT NULL DEFAULT false,
  ip_address          inet,
  user_agent          text,
  result              text        NOT NULL DEFAULT 'success'
                      CHECK (result IN ('success','failure','locked_out')),
  failure_reason      text,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authentication_event_user ON authentication_event (user_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Device
-- ---------------------------------------------------------------------------
CREATE TABLE device (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id              uuid,   -- FK added in 0005 once project exists
  label                   text        NOT NULL,
  platform                text        NOT NULL,
  device_fingerprint      text        NOT NULL,
  enrolment_status        text        NOT NULL DEFAULT 'pending'
                          CHECK (enrolment_status IN ('pending','trusted','revoked')),
  device_secret_hash      text,
  is_shared               boolean     NOT NULL DEFAULT false,
  bound_zone_id           uuid,   -- FK added in 0005
  enrolled_by             uuid        REFERENCES user_account(id),
  -- The full-MFA event that authorised this device's enrolment. Without it the
  -- device is not trusted, and no unlock on it can be trusted either.
  enrolment_auth_event_id uuid        REFERENCES authentication_event(id),
  enrolled_at             timestamptz,
  last_attested_at        timestamptz,
  revoked_at              timestamptz,
  revoked_by              uuid        REFERENCES user_account(id),
  revoke_reason           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  -- A device cannot be trusted without a recorded, MFA-backed enrolment event.
  CONSTRAINT trusted_requires_mfa_enrolment CHECK (
    enrolment_status <> 'trusted'
    OR (enrolled_by IS NOT NULL AND enrolment_auth_event_id IS NOT NULL
        AND enrolled_at IS NOT NULL)
  ),
  CONSTRAINT revoked_has_reason CHECK (
    enrolment_status <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX device_fingerprint_live ON device (device_fingerprint)
  WHERE enrolment_status <> 'revoked';

ALTER TABLE authentication_event
  ADD CONSTRAINT authentication_event_device_fk
  FOREIGN KEY (device_id) REFERENCES device(id);
ALTER TABLE auth_passkey
  ADD CONSTRAINT auth_passkey_device_fk
  FOREIGN KEY (device_id) REFERENCES device(id);

-- Enforce that the enrolment event was actually strong enough. A device cannot
-- be trusted on the back of a device_pin unlock, which would be circular.
CREATE OR REPLACE FUNCTION auth.assert_device_enrolment_strength() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ev record;
BEGIN
  IF NEW.enrolment_status <> 'trusted' THEN RETURN NEW; END IF;
  SELECT * INTO ev FROM authentication_event WHERE id = NEW.enrolment_auth_event_id;
  IF ev IS NULL THEN
    RAISE EXCEPTION 'LOTLINE_DEVICE_ENROLMENT_INVALID: enrolment event not found';
  END IF;
  IF ev.result <> 'success' OR NOT ev.mfa_satisfied OR ev.strength <> 'step_up' THEN
    RAISE EXCEPTION
      'LOTLINE_DEVICE_ENROLMENT_WEAK: device enrolment requires a successful step-up, MFA-satisfied authentication (got strength=%, mfa=%, result=%)',
      ev.strength, ev.mfa_satisfied, ev.result;
  END IF;
  IF ev.user_id <> NEW.enrolled_by THEN
    RAISE EXCEPTION 'LOTLINE_DEVICE_ENROLMENT_INVALID: enrolment event belongs to a different user';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_enrolment_strength
  BEFORE INSERT OR UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION auth.assert_device_enrolment_strength();

-- ---------------------------------------------------------------------------
-- Per-user unlock on a trusted device
-- ---------------------------------------------------------------------------
CREATE TABLE device_user_enrolment (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  device_id               uuid        NOT NULL REFERENCES device(id),
  user_id                 uuid        NOT NULL REFERENCES user_account(id),
  credential_kind         text        NOT NULL
                          CHECK (credential_kind IN ('pin','platform_passkey')),
  pin_hash                text,       -- argon2id, per-user salt; null for passkey
  passkey_id              uuid        REFERENCES auth_passkey(id),
  -- The user's OWN full authentication that bound them to this device. This is
  -- what stops a PIN asserting an unverified identity.
  enrolment_auth_event_id uuid        NOT NULL REFERENCES authentication_event(id),
  failed_attempts         int         NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  enrolled_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at              timestamptz,
  CONSTRAINT credential_matches_kind CHECK (
    (credential_kind = 'pin'              AND pin_hash IS NOT NULL AND passkey_id IS NULL)
    OR (credential_kind = 'platform_passkey' AND passkey_id IS NOT NULL AND pin_hash IS NULL)
  )
);
CREATE UNIQUE INDEX device_user_enrolment_live
  ON device_user_enrolment (device_id, user_id) WHERE revoked_at IS NULL;

-- The binding user's own authentication must be strong and must be theirs.
CREATE OR REPLACE FUNCTION auth.assert_user_enrolment_strength() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ev record; dev record;
BEGIN
  SELECT * INTO dev FROM device WHERE id = NEW.device_id;
  IF dev.enrolment_status <> 'trusted' THEN
    RAISE EXCEPTION 'LOTLINE_DEVICE_NOT_TRUSTED: cannot enrol a user on a % device',
      dev.enrolment_status;
  END IF;

  SELECT * INTO ev FROM authentication_event WHERE id = NEW.enrolment_auth_event_id;
  IF ev IS NULL OR ev.result <> 'success' OR NOT ev.mfa_satisfied THEN
    RAISE EXCEPTION
      'LOTLINE_USER_ENROLMENT_WEAK: binding a user to a device requires their own successful MFA authentication';
  END IF;
  IF ev.user_id <> NEW.user_id THEN
    RAISE EXCEPTION
      'LOTLINE_USER_ENROLMENT_MISMATCH: the enrolment event belongs to a different user — a PIN must bind the identity that was actually verified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_user_enrolment_strength
  BEFORE INSERT OR UPDATE ON device_user_enrolment
  FOR EACH ROW EXECUTE FUNCTION auth.assert_user_enrolment_strength();
