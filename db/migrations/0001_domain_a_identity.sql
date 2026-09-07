-- 0001 — Domain A, part 1: organisations, users and the four authentication
-- patterns (ADR-0021).
--
-- The supply chain does not have one identity story. Contractor staff have
-- Entra. Client agencies and independent verifiers have their own IdPs and will
-- not be guested into a vendor tenant. Subcontractors and suppliers are
-- frequently ten-person outfits with no enterprise identity at all. Site tablets
-- are shared and a foreman will not complete an MFA challenge thirty times a
-- shift. All four are modelled here.

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
CREATE TABLE organisation (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  legal_name    text        NOT NULL,
  trading_name  text,
  abn           text,
  org_type      text        NOT NULL
                CHECK (org_type IN ('contractor','client','subcontractor','supplier',
                                    'verifier','consultant','laboratory')),
  is_tenant     boolean     NOT NULL DEFAULT false,
  branding      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  superseded_by_id    uuid REFERENCES organisation(id),
  superseded_at       timestamptz,
  supersede_reason    text,
  CONSTRAINT abn_shape CHECK (abn IS NULL OR abn ~ '^[0-9]{11}$')
);
CREATE UNIQUE INDEX organisation_abn_live ON organisation (abn)
  WHERE abn IS NOT NULL AND superseded_by_id IS NULL;

-- ---------------------------------------------------------------------------
-- User account
-- ---------------------------------------------------------------------------
-- One human, one row, even across employers over time. citext so case never
-- forks an identity.
CREATE TABLE user_account (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  email           citext      NOT NULL,
  full_name       text        NOT NULL,
  mobile_e164     text,
  status          text        NOT NULL DEFAULT 'invited'
                  CHECK (status IN ('invited','active','suspended','departed')),
  primary_org_id  uuid        NOT NULL REFERENCES organisation(id),
  auth_pattern    text        NOT NULL
                  CHECK (auth_pattern IN ('home_tenant','federated_oidc',
                                          'guest_b2b','local_credentials')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  superseded_by_id uuid REFERENCES user_account(id),
  superseded_at    timestamptz,
  supersede_reason text,
  CONSTRAINT mobile_e164_shape CHECK (mobile_e164 IS NULL OR mobile_e164 ~ '^\+[1-9][0-9]{6,14}$')
);
CREATE UNIQUE INDEX user_account_email_live ON user_account (email)
  WHERE superseded_by_id IS NULL;
CREATE INDEX user_account_primary_org ON user_account (primary_org_id);

-- ---------------------------------------------------------------------------
-- Federated identity providers (pattern 2: client and IV bring their own IdP)
-- ---------------------------------------------------------------------------
CREATE TABLE org_identity_provider (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid        NOT NULL REFERENCES organisation(id),
  protocol              text        NOT NULL CHECK (protocol IN ('oidc','saml2')),
  issuer                text        NOT NULL,
  client_id             text        NOT NULL,
  jwks_uri              text,
  metadata_url          text,
  -- Home-realm discovery: an inbound email domain routes to this provider.
  allowed_email_domains text[]      NOT NULL DEFAULT '{}',
  enforces_mfa          boolean     NOT NULL DEFAULT true,
  status                text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','suspended')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);
CREATE UNIQUE INDEX org_idp_issuer ON org_identity_provider (issuer);
-- A given email domain may route to exactly one active provider, or home-realm
-- discovery is ambiguous and a user could be steered to the wrong tenant.
CREATE OR REPLACE FUNCTION auth.assert_idp_domains_disjoint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE clash text;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT string_agg(d, ', ') INTO clash
  FROM (
    SELECT unnest(NEW.allowed_email_domains)
    INTERSECT
    SELECT unnest(allowed_email_domains)
      FROM org_identity_provider
     WHERE id <> NEW.id AND status = 'active'
  ) AS x(d);
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_IDP_DOMAIN_CLASH: % already routed by another active provider', clash;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_idp_domains_disjoint
  BEFORE INSERT OR UPDATE ON org_identity_provider
  FOR EACH ROW EXECUTE FUNCTION auth.assert_idp_domains_disjoint();

-- ---------------------------------------------------------------------------
-- Authentication routes held by a user
-- ---------------------------------------------------------------------------
CREATE TABLE auth_identity (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id                  uuid        NOT NULL REFERENCES user_account(id),
  provider                 text        NOT NULL
                           CHECK (provider IN ('entra_home','entra_guest',
                                               'oidc_federated','local')),
  org_identity_provider_id uuid        REFERENCES org_identity_provider(id),
  subject                  text        NOT NULL,
  last_authenticated_at    timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  CONSTRAINT federated_has_provider CHECK (
    (provider = 'oidc_federated') = (org_identity_provider_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX auth_identity_subject ON auth_identity (provider, subject)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_identity_user ON auth_identity (user_id);

-- Pattern 3: local credentials + TOTP, for organisations with no enterprise
-- identity. Gating a ten-person subcontractor behind enterprise SSO pushes them
-- back to emailing PDFs, which defeats the product.
CREATE TABLE auth_credential (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id           uuid        NOT NULL UNIQUE REFERENCES user_account(id),
  password_hash     text        NOT NULL,  -- argon2id, computed in the application
  must_change_after timestamptz,
  failed_attempts   int         NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_totp (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id               uuid        NOT NULL REFERENCES user_account(id),
  secret_encrypted      bytea       NOT NULL,
  confirmed_at          timestamptz,
  recovery_code_hashes  text[]      NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);
CREATE UNIQUE INDEX auth_totp_active ON auth_totp (user_id) WHERE revoked_at IS NULL;

-- WebAuthn platform authenticator. Preferred over a PIN wherever the device
-- supports it: the biometric never leaves the device and we get a cryptographic
-- assertion rather than a shared secret.
CREATE TABLE auth_passkey (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id       uuid        NOT NULL REFERENCES user_account(id),
  device_id     uuid,  -- FK added in 0002 once device exists
  credential_id bytea       NOT NULL,
  public_key    bytea       NOT NULL,
  aaguid        text,
  transport     text CHECK (transport IN ('internal','hybrid','usb','nfc','ble')),
  sign_count    bigint      NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX auth_passkey_credential ON auth_passkey (credential_id);
CREATE INDEX auth_passkey_user ON auth_passkey (user_id) WHERE revoked_at IS NULL;
