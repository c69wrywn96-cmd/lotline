-- 0005 — project_membership and the access_grant projection (ADR-0020, ADR-0023).
--
-- access_grant is a trigger-maintained flattening of membership. It exists for
-- one reason: RLS predicates run per candidate row, and a predicate that joins
-- project_membership -> role -> ... at 10,000 lots is unacceptable. Its primary
-- key IS the predicate's lookup.
--
-- Read scope and write scope are separate rows. A joint venture reads
-- project-wide and writes only its assigned zones and WBS subtrees: a JV
-- delivers one contract under one QMS with one ITP library, so partner-segregated
-- QA data would be a fiction, but each partner's engineers own their geography.
--
-- The split must NOT widen the external fence. An external membership
-- (subcontractor, supplier) yields narrow grants for BOTH kinds. This is asserted
-- three ways: a CHECK on role, a CHECK on access_grant, and a test.

CREATE TABLE project_membership (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        uuid        NOT NULL REFERENCES project(id),
  user_id           uuid        NOT NULL REFERENCES user_account(id),
  role_id           uuid        NOT NULL REFERENCES role(id),
  read_scope_type   text        NOT NULL DEFAULT 'project'
                    CHECK (read_scope_type IN ('project','zone','wbs','package','crew','supplier_org')),
  read_scope_id     uuid,
  write_scope_type  text        NOT NULL DEFAULT 'none'
                    CHECK (write_scope_type IN ('none','project','zone','wbs','package','crew','supplier_org')),
  write_scope_id    uuid,
  active_period     daterange   NOT NULL DEFAULT daterange(CURRENT_DATE, NULL, '[)'),
  granted_by        uuid        REFERENCES user_account(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  CONSTRAINT read_scope_id_presence CHECK (
    (read_scope_type = 'project') = (read_scope_id IS NULL)
  ),
  CONSTRAINT write_scope_id_presence CHECK (
    (write_scope_type IN ('none','project')) = (write_scope_id IS NULL)
  )
);
CREATE INDEX project_membership_user ON project_membership (user_id, project_id);
CREATE INDEX project_membership_project ON project_membership (project_id);

-- A project membership may only carry a project-scoped role.
CREATE OR REPLACE FUNCTION auth.assert_project_membership_role_level() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM role WHERE id = NEW.role_id;
  IF r.scope_level <> 'project' THEN
    RAISE EXCEPTION
      'LOTLINE_ROLE_SCOPE_MISMATCH: role % is organisation-scoped and is held via org_membership', r.code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_membership_role_level
  BEFORE INSERT OR UPDATE ON project_membership
  FOR EACH ROW EXECUTE FUNCTION auth.assert_project_membership_role_level();

-- ---------------------------------------------------------------------------
-- access_grant
-- ---------------------------------------------------------------------------
CREATE TABLE access_grant (
  user_id     uuid  NOT NULL REFERENCES user_account(id),
  project_id  uuid  NOT NULL REFERENCES project(id),
  grant_kind  text  NOT NULL CHECK (grant_kind IN ('read','write')),
  scope_type  text  NOT NULL
              CHECK (scope_type IN ('project','zone','wbs','package','crew','supplier_org')),
  scope_id    uuid  NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  scope_path  ltree,
  side        text  NOT NULL CHECK (side IN ('contractor','client','verifier','external')),
  -- Which membership produced this row. Org-scoped grants (ADR-0023) are not
  -- traceable to a project_membership, so the projection is discriminated.
  source      text  NOT NULL CHECK (source IN ('project_membership','org_membership')),
  source_id   uuid  NOT NULL,
  PRIMARY KEY (user_id, project_id, grant_kind, scope_type, scope_id),
  -- ADR-0020: the external fence. No subcontractor or supplier membership of
  -- either kind may ever produce a project-wide grant.
  CONSTRAINT external_never_project_scope CHECK (
    side <> 'external' OR scope_type <> 'project'
  ),
  CONSTRAINT subtree_scope_has_path CHECK (
    (scope_type IN ('zone','wbs')) = (scope_path IS NOT NULL)
  )
);
CREATE INDEX access_grant_path_gix ON access_grant USING gist (scope_path);
CREATE INDEX access_grant_source ON access_grant (source, source_id);

-- Application code never writes this table.
REVOKE INSERT, UPDATE, DELETE ON access_grant FROM lotline_app, lotline_worker;

-- ---------------------------------------------------------------------------
-- Projection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.scope_path_for(p_scope_type text, p_scope_id uuid)
RETURNS ltree LANGUAGE plpgsql STABLE AS $$
DECLARE r ltree;
BEGIN
  IF p_scope_type = 'zone' THEN
    SELECT path INTO r FROM zone WHERE id = p_scope_id;
    IF r IS NULL THEN RAISE EXCEPTION 'LOTLINE_SCOPE_ZONE_MISSING: %', p_scope_id; END IF;
  ELSIF p_scope_type = 'wbs' THEN
    SELECT path INTO r FROM wbs_element WHERE id = p_scope_id;
    IF r IS NULL THEN RAISE EXCEPTION 'LOTLINE_SCOPE_WBS_MISSING: %', p_scope_id; END IF;
  END IF;
  RETURN r;
END $$;

-- Rebuild every grant derived from one project_membership.
CREATE OR REPLACE FUNCTION auth.project_grants_rebuild(p_membership_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE m record; r record; is_active boolean;
BEGIN
  DELETE FROM access_grant WHERE source = 'project_membership' AND source_id = p_membership_id;

  SELECT * INTO m FROM project_membership WHERE id = p_membership_id;
  IF m IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM role WHERE id = m.role_id;

  is_active := m.active_period @> CURRENT_DATE;
  IF NOT is_active THEN RETURN; END IF;   -- lapsed access simply has no rows

  -- READ grant. A role that grants project-wide read overrides the membership's
  -- read scope; this is how a JV partner's Section Engineer sees the whole
  -- project while writing only their zone.
  IF r.grants_project_wide_read THEN
    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id)
    VALUES (m.user_id, m.project_id, 'read', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, r.side,
            'project_membership', m.id);
  ELSE
    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id)
    VALUES (m.user_id, m.project_id, 'read', m.read_scope_type,
            COALESCE(m.read_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
            auth.scope_path_for(m.read_scope_type, m.read_scope_id), r.side,
            'project_membership', m.id);
  END IF;

  -- WRITE grant. 'none' means read-and-sign only (Independent Verifier, Auditor).
  IF m.write_scope_type <> 'none' THEN
    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id)
    VALUES (m.user_id, m.project_id, 'write', m.write_scope_type,
            COALESCE(m.write_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
            auth.scope_path_for(m.write_scope_type, m.write_scope_id), r.side,
            'project_membership', m.id)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Rebuild every grant derived from one org_membership. An organisation-scoped
-- role fans out to every project the organisation actively participates in, so a
-- Group Quality Manager gains and loses project visibility automatically as the
-- portfolio changes, with no per-project administration (ADR-0023).
CREATE OR REPLACE FUNCTION auth.org_grants_rebuild(p_membership_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE m record; r record; pp record;
BEGIN
  DELETE FROM access_grant WHERE source = 'org_membership' AND source_id = p_membership_id;

  SELECT * INTO m FROM org_membership WHERE id = p_membership_id;
  IF m IS NULL OR m.role_id IS NULL THEN RETURN; END IF;
  IF NOT (m.active_period @> CURRENT_DATE) THEN RETURN; END IF;

  SELECT * INTO r FROM role WHERE id = m.role_id;
  IF r.side = 'external' THEN
    -- Defence in depth: role.external_never_project_wide already forbids this,
    -- and access_grant.external_never_project_scope would reject the row.
    RETURN;
  END IF;

  FOR pp IN
    SELECT * FROM project_participant
     WHERE organisation_id = m.organisation_id AND active_period @> CURRENT_DATE
  LOOP
    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id)
    VALUES (m.user_id, pp.project_id, 'read', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, r.side,
            'org_membership', m.id)
    ON CONFLICT DO NOTHING;

    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id)
    VALUES (m.user_id, pp.project_id, 'write', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, r.side,
            'org_membership', m.id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION auth.tg_project_membership_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM access_grant WHERE source = 'project_membership' AND source_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM auth.project_grants_rebuild(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER project_membership_grants
  AFTER INSERT OR UPDATE OR DELETE ON project_membership
  FOR EACH ROW EXECUTE FUNCTION auth.tg_project_membership_grants();

CREATE OR REPLACE FUNCTION auth.tg_org_membership_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM access_grant WHERE source = 'org_membership' AND source_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM auth.org_grants_rebuild(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER org_membership_grants
  AFTER INSERT OR UPDATE OR DELETE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION auth.tg_org_membership_grants();

-- Participation changes move org-scoped grants with them, in both directions.
CREATE OR REPLACE FUNCTION auth.tg_participant_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE m record;
BEGIN
  FOR m IN
    SELECT om.id FROM org_membership om
     WHERE om.organisation_id = COALESCE(NEW.organisation_id, OLD.organisation_id)
       AND om.role_id IS NOT NULL
  LOOP
    PERFORM auth.org_grants_rebuild(m.id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER participant_grants
  AFTER INSERT OR UPDATE OR DELETE ON project_participant
  FOR EACH ROW EXECUTE FUNCTION auth.tg_participant_grants();

-- Re-parenting a zone or WBS element rewrites subtree paths; the grants that
-- carry those paths must follow, or a write scope silently points at a stale
-- subtree.
CREATE OR REPLACE FUNCTION auth.tg_resync_scope_paths() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'zone' THEN
    UPDATE access_grant SET scope_path = NEW.path
     WHERE scope_type = 'zone' AND scope_id = NEW.id;
  ELSE
    UPDATE access_grant SET scope_path = NEW.path
     WHERE scope_type = 'wbs' AND scope_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zone_grant_path_resync AFTER UPDATE OF path ON zone
  FOR EACH ROW EXECUTE FUNCTION auth.tg_resync_scope_paths();
CREATE TRIGGER wbs_grant_path_resync AFTER UPDATE OF path ON wbs_element
  FOR EACH ROW EXECUTE FUNCTION auth.tg_resync_scope_paths();

-- ---------------------------------------------------------------------------
-- The scope predicate every RLS policy calls.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.in_scope(
  p_kind        text,
  p_project_id  uuid,
  p_zone_path   ltree   DEFAULT NULL,
  p_wbs_path    ltree   DEFAULT NULL,
  p_package_id  uuid    DEFAULT NULL,
  p_supplier_id uuid    DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM access_grant g
    WHERE g.user_id    = auth.user_id()
      AND g.project_id = p_project_id
      AND g.grant_kind = p_kind
      AND (
            g.scope_type = 'project'
        OR (g.scope_type = 'zone'         AND p_zone_path IS NOT NULL AND p_zone_path <@ g.scope_path)
        OR (g.scope_type = 'wbs'          AND p_wbs_path  IS NOT NULL AND p_wbs_path  <@ g.scope_path)
        OR (g.scope_type = 'package'      AND p_package_id  IS NOT NULL AND g.scope_id = p_package_id)
        OR (g.scope_type = 'supplier_org' AND p_supplier_id IS NOT NULL AND g.scope_id = p_supplier_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION auth.user_side(p_project_id uuid) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT side FROM access_grant
   WHERE user_id = auth.user_id() AND project_id = p_project_id AND grant_kind = 'read'
   LIMIT 1;
$$;
