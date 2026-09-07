-- 0003 — Domain A, part 3: roles, permissions, memberships.
--
-- Permission-per-action, never three hardcoded tiers (ADR-0002). No application
-- code branches on a role name. Roles are tenant-editable bundles; numeric and
-- contextual bounds live in role_permission.constraint_json, which is how
-- "approve NCR closeout > $50k" is expressed without a bespoke role.
--
-- Roles exist at TWO scope levels (ADR-0023). A project-scoped role is held via
-- project_membership. An organisation-scoped role is held via org_membership and
-- fans out to every project the organisation participates in — which is what
-- unsticks the two-person QA team that cannot produce a second eligible
-- signatory for a signature withdrawal.

-- ---------------------------------------------------------------------------
-- Permission catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE permission (
  code              text PRIMARY KEY,
  resource          text NOT NULL,
  action            text NOT NULL,
  description       text NOT NULL,
  -- The authentication floor for this action, as data rather than as scattered
  -- conditionals. See 03-permission-matrix.md §10.
  min_auth_strength text NOT NULL DEFAULT 'session'
                    CHECK (min_auth_strength IN ('session','device_unlock','step_up')),
  -- Whether this action is available at all on a device-bound (shared tablet)
  -- session. Role management, exports and API keys are not.
  device_bound_allowed boolean NOT NULL DEFAULT true,
  CONSTRAINT code_shape CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
CREATE TABLE role (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  owner_org_id       uuid REFERENCES organisation(id),  -- null = system template
  code               text        NOT NULL,
  name               text        NOT NULL,
  side               text        NOT NULL
                     CHECK (side IN ('contractor','client','verifier','external')),
  scope_level        text        NOT NULL DEFAULT 'project'
                     CHECK (scope_level IN ('organisation','project')),
  is_system_template boolean     NOT NULL DEFAULT false,
  -- Whether memberships of this role yield a project-wide READ grant.
  -- Hard-false for every external role; asserted below and tested.
  grants_project_wide_read boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  CONSTRAINT system_template_has_no_owner CHECK (is_system_template = (owner_org_id IS NULL)),
  -- ADR-0020: an external role can never carry project-wide read. Enforced in
  -- the type system of the data, not in the projection logic alone.
  CONSTRAINT external_never_project_wide CHECK (
    side <> 'external' OR grants_project_wide_read = false
  )
);
CREATE UNIQUE INDEX role_code_system ON role (code) WHERE owner_org_id IS NULL;
CREATE UNIQUE INDEX role_code_tenant ON role (owner_org_id, code) WHERE owner_org_id IS NOT NULL;

CREATE TABLE role_permission (
  role_id         uuid NOT NULL REFERENCES role(id),
  permission_code text NOT NULL REFERENCES permission(code),
  constraint_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (role_id, permission_code)
);

-- ---------------------------------------------------------------------------
-- Employment / organisation membership.
-- A null role_id is plain employment. A non-null role_id is a standing
-- appointment at organisation level (ADR-0023) — e.g. Group Quality Manager.
-- ---------------------------------------------------------------------------
CREATE TABLE org_membership (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid        NOT NULL REFERENCES organisation(id),
  user_id         uuid        NOT NULL REFERENCES user_account(id),
  role_id         uuid        REFERENCES role(id),
  job_title       text,
  active_period   daterange   NOT NULL DEFAULT daterange(CURRENT_DATE, NULL, '[)'),
  granted_by      uuid        REFERENCES user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);
CREATE INDEX org_membership_user ON org_membership (user_id);
CREATE INDEX org_membership_org  ON org_membership (organisation_id);

-- An org membership may only carry an organisation-scoped role.
CREATE OR REPLACE FUNCTION auth.assert_org_membership_role_level() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.role_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM role WHERE id = NEW.role_id;
  IF r.scope_level <> 'organisation' THEN
    RAISE EXCEPTION
      'LOTLINE_ROLE_SCOPE_MISMATCH: role % is project-scoped and cannot be held at organisation level', r.code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_membership_role_level
  BEFORE INSERT OR UPDATE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION auth.assert_org_membership_role_level();

-- ---------------------------------------------------------------------------
-- Time-boxed individual exceptions and acting-for delegation
-- ---------------------------------------------------------------------------
CREATE TABLE permission_grant (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id         uuid        NOT NULL REFERENCES user_account(id),
  project_id      uuid,       -- FK added in 0005
  permission_code text        NOT NULL REFERENCES permission(code),
  valid_period    tstzrange   NOT NULL,
  granted_by      uuid        NOT NULL REFERENCES user_account(id),
  justification   text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX permission_grant_lookup ON permission_grant (user_id, project_id, permission_code);

CREATE TABLE delegation (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id          uuid,   -- FK added in 0005
  from_user_id        uuid        NOT NULL REFERENCES user_account(id),
  to_user_id          uuid        NOT NULL REFERENCES user_account(id),
  permission_codes    text[]      NOT NULL,
  valid_period        tstzrange   NOT NULL,
  -- Hold release and conformance certification are never delegable (ADR-0002).
  signature_delegable boolean     NOT NULL DEFAULT false,
  reason              text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT no_self_delegation CHECK (from_user_id <> to_user_id)
);
CREATE INDEX delegation_to_user ON delegation (to_user_id, project_id);

-- Non-delegable permissions may never appear in a delegation, whatever the flag
-- says. Belt and braces around ADR-0002.
CREATE OR REPLACE FUNCTION auth.assert_delegable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c, ', ') INTO bad
  FROM unnest(NEW.permission_codes) AS c
  WHERE c IN ('checkpoint.hold.release',
              'checkpoint.hold.release.retrospective',
              'lot.certify_conformance',
              'lot.accept');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_NOT_DELEGABLE: % cannot be delegated', bad;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delegation_delegable
  BEFORE INSERT OR UPDATE ON delegation
  FOR EACH ROW EXECUTE FUNCTION auth.assert_delegable();
